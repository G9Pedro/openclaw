import type { Command } from "commander";
import type { CronJob } from "../../cron/types.js";
import type { GatewayRpcOpts } from "../gateway-rpc.js";
import {
  DEFAULT_AUTONOMY_GOALS_FILE,
  DEFAULT_AUTONOMY_LOG_FILE,
  DEFAULT_AUTONOMY_MISSION,
  DEFAULT_AUTONOMY_TASKS_FILE,
} from "../../agents/autonomy-primitives.js";
import {
  enqueueAutonomyEvent,
  loadAutonomyState,
  resetAutonomyRuntime,
} from "../../autonomy/store.js";
import { danger } from "../../globals.js";
import { sanitizeAgentId } from "../../routing/session-key.js";
import { defaultRuntime } from "../../runtime.js";
import { addGatewayClientOptions, callGatewayFromCli } from "../gateway-rpc.js";
import { parsePositiveIntOrUndefined } from "../program/helpers.js";
import { getCronChannelOptions, parseDurationMs, warnIfCronSchedulerDisabled } from "./shared.js";

const DEFAULT_AUTONOMOUS_NAME = "Autonomous engine";
const DEFAULT_AUTONOMOUS_CADENCE = "10m";
const AUTONOMY_SOURCES = new Set(["cron", "webhook", "email", "subagent", "manual"]);

function getTrimmedString(value: unknown) {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function isAutonomousJob(job: CronJob) {
  return job.payload.kind === "agentTurn" && job.payload.autonomy?.enabled === true;
}

function formatAutonomySummary(jobs: CronJob[]) {
  const lines = [
    "Autonomous jobs:",
    ...jobs.map((job) => {
      const paused = job.payload.kind === "agentTurn" && job.payload.autonomy?.paused === true;
      const status = paused ? "paused" : job.enabled ? "active" : "disabled";
      const next =
        typeof job.state.nextRunAtMs === "number"
          ? new Date(job.state.nextRunAtMs).toISOString()
          : "-";
      return `- ${job.id} (${job.name}) status=${status} agent=${job.agentId ?? "default"} next=${next}`;
    }),
  ];
  return lines.join("\n");
}

export function registerCronAutonomousCommand(cron: Command) {
  addGatewayClientOptions(
    cron
      .command("autonomous")
      .alias("auto")
      .description("Install a recurring autonomous engine job with coordination primitives")
      .option("--name <name>", "Job name", DEFAULT_AUTONOMOUS_NAME)
      .option("--description <text>", "Optional job description")
      .option("--mission <text>", "High-level mission for the autonomous engine")
      .option("--every <duration>", "Run cadence (e.g. 5m, 30m, 1h)", DEFAULT_AUTONOMOUS_CADENCE)
      .option("--agent <id>", "Agent id for this job")
      .option("--wake <mode>", "Wake mode (now|next-heartbeat)", "next-heartbeat")
      .option("--model <model>", "Model override for the autonomous run")
      .option("--thinking <level>", "Thinking level for the autonomous run")
      .option("--timeout-seconds <n>", "Timeout seconds for each run")
      .option("--goals-file <path>", "Path for persistent goals file", DEFAULT_AUTONOMY_GOALS_FILE)
      .option("--tasks-file <path>", "Path for persistent tasks file", DEFAULT_AUTONOMY_TASKS_FILE)
      .option("--log-file <path>", "Path for persistent execution log", DEFAULT_AUTONOMY_LOG_FILE)
      .option("--max-actions <n>", "Max meaningful actions per run", "3")
      .option("--dedupe-window-minutes <n>", "Event dedupe window in minutes", "60")
      .option("--max-queued-events <n>", "Max queued events consumed each cycle", "100")
      .option("--daily-token-budget <n>", "Daily token budget cap for autonomy cycles")
      .option("--daily-cycle-budget <n>", "Daily cycle budget cap for autonomy cycles")
      .option("--max-consecutive-errors <n>", "Auto-pause after N consecutive errors", "5")
      .option("--auto-pause-on-budget", "Auto-pause when daily budgets are exhausted", true)
      .option("--no-auto-pause-on-budget", "Do not auto-pause when budgets are exhausted")
      .option(
        "--auto-resume-on-new-day-budget",
        "Auto-resume autonomy when a new day resets budget window",
        true,
      )
      .option("--no-auto-resume-on-new-day-budget", "Keep autonomy paused even after day rollover")
      .option(
        "--error-pause-minutes <n>",
        "Cooldown minutes before auto-resuming after error pause",
      )
      .option("--stale-task-hours <n>", "Hours before blocked/in-progress tasks emit stale signals")
      .option("--emit-daily-review-events", "Emit automatic daily self-review events", true)
      .option("--no-emit-daily-review-events", "Disable automatic daily self-review events")
      .option("--emit-weekly-review-events", "Emit automatic weekly evolution events", true)
      .option("--no-emit-weekly-review-events", "Disable automatic weekly evolution events")
      .option("--deliver", "Deliver output to a channel target when configured", false)
      .option("--channel <channel>", `Delivery channel (${getCronChannelOptions()})`, "last")
      .option(
        "--to <dest>",
        "Delivery destination (E.164, Telegram chatId, or Discord channel/user)",
      )
      .option("--best-effort-deliver", "Do not fail the job if delivery fails", false)
      .option("--disabled", "Create job disabled", false)
      .option("--post-prefix <prefix>", "Prefix for main-session post", "Autonomy")
      .option("--json", "Output JSON", false)
      .action(async (opts: GatewayRpcOpts & Record<string, unknown>) => {
        try {
          const name = getTrimmedString(opts.name) ?? DEFAULT_AUTONOMOUS_NAME;
          const cadenceRaw = getTrimmedString(opts.every) ?? DEFAULT_AUTONOMOUS_CADENCE;
          const everyMs = parseDurationMs(cadenceRaw);
          if (!everyMs) {
            throw new Error("Invalid --every; use e.g. 5m, 30m, 1h, 1d");
          }

          const wakeModeRaw = getTrimmedString(opts.wake) ?? "next-heartbeat";
          if (wakeModeRaw !== "now" && wakeModeRaw !== "next-heartbeat") {
            throw new Error("--wake must be now or next-heartbeat");
          }

          const timeoutSeconds = parsePositiveIntOrUndefined(opts.timeoutSeconds);
          const maxActions = parsePositiveIntOrUndefined(opts.maxActions) ?? 3;
          const mission = getTrimmedString(opts.mission) ?? DEFAULT_AUTONOMY_MISSION;
          const goalsFile = getTrimmedString(opts.goalsFile) ?? DEFAULT_AUTONOMY_GOALS_FILE;
          const tasksFile = getTrimmedString(opts.tasksFile) ?? DEFAULT_AUTONOMY_TASKS_FILE;
          const logFile = getTrimmedString(opts.logFile) ?? DEFAULT_AUTONOMY_LOG_FILE;
          const dedupeWindowMinutes = parsePositiveIntOrUndefined(opts.dedupeWindowMinutes) ?? 60;
          const maxQueuedEvents = parsePositiveIntOrUndefined(opts.maxQueuedEvents) ?? 100;
          const dailyTokenBudget = parsePositiveIntOrUndefined(opts.dailyTokenBudget);
          const dailyCycleBudget = parsePositiveIntOrUndefined(opts.dailyCycleBudget);
          const maxConsecutiveErrors = parsePositiveIntOrUndefined(opts.maxConsecutiveErrors) ?? 5;
          const autoPauseOnBudgetExhausted = opts.autoPauseOnBudget !== false;
          const autoResumeOnNewDayBudgetPause = opts.autoResumeOnNewDayBudget !== false;
          const errorPauseMinutes = parsePositiveIntOrUndefined(opts.errorPauseMinutes) ?? 240;
          const staleTaskHours = parsePositiveIntOrUndefined(opts.staleTaskHours) ?? 24;
          const emitDailyReviewEvents = opts.emitDailyReviewEvents !== false;
          const emitWeeklyReviewEvents = opts.emitWeeklyReviewEvents !== false;

          const agentId =
            typeof opts.agent === "string" && opts.agent.trim()
              ? sanitizeAgentId(opts.agent.trim())
              : undefined;

          const params = {
            name,
            description: getTrimmedString(opts.description),
            enabled: !opts.disabled,
            deleteAfterRun: false,
            agentId,
            schedule: { kind: "every" as const, everyMs },
            sessionTarget: "isolated" as const,
            wakeMode: wakeModeRaw,
            payload: {
              kind: "agentTurn" as const,
              message: `Run autonomous coordination cycle for mission: ${mission}`,
              model: getTrimmedString(opts.model),
              thinking: getTrimmedString(opts.thinking),
              timeoutSeconds:
                timeoutSeconds && Number.isFinite(timeoutSeconds) ? timeoutSeconds : undefined,
              deliver: opts.deliver ? true : undefined,
              channel: typeof opts.channel === "string" ? opts.channel : "last",
              to: getTrimmedString(opts.to),
              bestEffortDeliver: opts.bestEffortDeliver ? true : undefined,
              autonomy: {
                enabled: true,
                paused: false,
                mission,
                goalsFile,
                tasksFile,
                logFile,
                maxActionsPerRun: maxActions,
                dedupeWindowMinutes,
                maxQueuedEvents,
                dailyTokenBudget,
                dailyCycleBudget,
                maxConsecutiveErrors,
                autoPauseOnBudgetExhausted,
                autoResumeOnNewDayBudgetPause,
                errorPauseMinutes,
                staleTaskHours,
                emitDailyReviewEvents,
                emitWeeklyReviewEvents,
              },
            },
            isolation: {
              postToMainPrefix: getTrimmedString(opts.postPrefix) ?? "Autonomy",
              postToMainMode: "summary" as const,
            },
          };

          const res = await callGatewayFromCli("cron.add", opts, params);
          defaultRuntime.log(JSON.stringify(res, null, 2));
          await warnIfCronSchedulerDisabled(opts);
        } catch (err) {
          defaultRuntime.error(danger(String(err)));
          defaultRuntime.exit(1);
        }
      }),
  );

  addGatewayClientOptions(
    cron
      .command("autonomous-status")
      .description("Show autonomous cron jobs and runtime status")
      .option("--json", "Output JSON", false)
      .action(async (opts) => {
        try {
          const res = (await callGatewayFromCli("cron.list", opts, {
            includeDisabled: true,
          })) as { jobs?: CronJob[] };
          const jobs = (res.jobs ?? []).filter(isAutonomousJob);
          if (opts.json) {
            defaultRuntime.log(JSON.stringify({ jobs }, null, 2));
            return;
          }
          if (jobs.length === 0) {
            defaultRuntime.log("No autonomous jobs configured.");
            return;
          }
          defaultRuntime.log(formatAutonomySummary(jobs));
        } catch (err) {
          defaultRuntime.error(danger(String(err)));
          defaultRuntime.exit(1);
        }
      }),
  );

  addGatewayClientOptions(
    cron
      .command("autonomous-pause")
      .description("Pause an autonomous cron job")
      .argument("<id>", "Job id")
      .action(async (id, opts) => {
        try {
          const res = await callGatewayFromCli("cron.update", opts, {
            id,
            patch: {
              payload: {
                kind: "agentTurn",
                autonomy: {
                  enabled: true,
                  paused: true,
                },
              },
            },
          });
          defaultRuntime.log(JSON.stringify(res, null, 2));
        } catch (err) {
          defaultRuntime.error(danger(String(err)));
          defaultRuntime.exit(1);
        }
      }),
  );

  addGatewayClientOptions(
    cron
      .command("autonomous-resume")
      .description("Resume a paused autonomous cron job")
      .argument("<id>", "Job id")
      .action(async (id, opts) => {
        try {
          const res = await callGatewayFromCli("cron.update", opts, {
            id,
            patch: {
              payload: {
                kind: "agentTurn",
                autonomy: {
                  enabled: true,
                  paused: false,
                },
              },
            },
          });
          defaultRuntime.log(JSON.stringify(res, null, 2));
        } catch (err) {
          defaultRuntime.error(danger(String(err)));
          defaultRuntime.exit(1);
        }
      }),
  );

  addGatewayClientOptions(
    cron
      .command("autonomous-inspect")
      .description("Inspect autonomy runtime state for an agent")
      .requiredOption("--agent <id>", "Target agent id")
      .option("--json", "Output JSON", false)
      .action(async (opts) => {
        try {
          const agentId = sanitizeAgentId(String(opts.agent));
          const state = await loadAutonomyState({ agentId });
          if (opts.json) {
            defaultRuntime.log(JSON.stringify(state, null, 2));
            return;
          }
          defaultRuntime.log(
            [
              `agent=${state.agentId}`,
              `paused=${state.paused}`,
              `pauseReason=${state.pauseReason ?? "none"}`,
              `pausedAt=${state.pausedAt ?? "-"}`,
              `mission=${state.mission}`,
              `goalsFile=${state.goalsFile}`,
              `tasksFile=${state.tasksFile}`,
              `logFile=${state.logFile}`,
              `maxActionsPerRun=${state.maxActionsPerRun}`,
              `dedupeWindowMs=${state.dedupeWindowMs}`,
              `maxQueuedEvents=${state.maxQueuedEvents}`,
              `budget.day=${state.budget.dayKey}`,
              `budget.cyclesUsed=${state.budget.cyclesUsed}`,
              `budget.tokensUsed=${state.budget.tokensUsed}`,
              `safety.dailyCycleBudget=${state.safety.dailyCycleBudget ?? "unbounded"}`,
              `safety.dailyTokenBudget=${state.safety.dailyTokenBudget ?? "unbounded"}`,
              `safety.maxConsecutiveErrors=${state.safety.maxConsecutiveErrors}`,
              `safety.autoPauseOnBudgetExhausted=${state.safety.autoPauseOnBudgetExhausted}`,
              `safety.autoResumeOnNewDayBudgetPause=${state.safety.autoResumeOnNewDayBudgetPause}`,
              `safety.errorPauseMinutes=${state.safety.errorPauseMinutes}`,
              `safety.staleTaskHours=${state.safety.staleTaskHours}`,
              `safety.emitDailyReviewEvents=${state.safety.emitDailyReviewEvents}`,
              `safety.emitWeeklyReviewEvents=${state.safety.emitWeeklyReviewEvents}`,
              `review.lastDailyReviewDayKey=${state.review.lastDailyReviewDayKey ?? "-"}`,
              `review.lastWeeklyReviewKey=${state.review.lastWeeklyReviewKey ?? "-"}`,
              `metrics.cycles=${state.metrics.cycles}`,
              `metrics.ok=${state.metrics.ok}`,
              `metrics.error=${state.metrics.error}`,
              `metrics.skipped=${state.metrics.skipped}`,
              `metrics.consecutiveErrors=${state.metrics.consecutiveErrors}`,
            ].join("\n"),
          );
        } catch (err) {
          defaultRuntime.error(danger(String(err)));
          defaultRuntime.exit(1);
        }
      }),
  );

  addGatewayClientOptions(
    cron
      .command("autonomous-health")
      .description("Summarize autonomy runtime health for an agent")
      .requiredOption("--agent <id>", "Target agent id")
      .option("--json", "Output JSON", false)
      .action(async (opts) => {
        try {
          const agentId = sanitizeAgentId(String(opts.agent));
          const state = await loadAutonomyState({ agentId });
          const cycleBudget = state.safety.dailyCycleBudget;
          const tokenBudget = state.safety.dailyTokenBudget;
          const cycleUsageRatio =
            typeof cycleBudget === "number" && cycleBudget > 0
              ? state.budget.cyclesUsed / cycleBudget
              : undefined;
          const tokenUsageRatio =
            typeof tokenBudget === "number" && tokenBudget > 0
              ? state.budget.tokensUsed / tokenBudget
              : undefined;
          const warnings: string[] = [];
          if (state.metrics.consecutiveErrors > 0) {
            warnings.push(`consecutive errors: ${state.metrics.consecutiveErrors}`);
          }
          if (typeof cycleUsageRatio === "number" && cycleUsageRatio >= 0.9) {
            warnings.push(
              `daily cycle budget near limit (${state.budget.cyclesUsed}/${cycleBudget})`,
            );
          }
          if (typeof tokenUsageRatio === "number" && tokenUsageRatio >= 0.9) {
            warnings.push(
              `daily token budget near limit (${state.budget.tokensUsed}/${tokenBudget})`,
            );
          }
          const status = state.paused ? "paused" : warnings.length > 0 ? "degraded" : "healthy";
          const health = {
            agentId: state.agentId,
            status,
            pauseReason: state.pauseReason,
            warnings,
            metrics: state.metrics,
            budget: {
              dayKey: state.budget.dayKey,
              cyclesUsed: state.budget.cyclesUsed,
              cycleBudget,
              tokensUsed: state.budget.tokensUsed,
              tokenBudget,
            },
          };
          if (opts.json) {
            defaultRuntime.log(JSON.stringify(health, null, 2));
            return;
          }
          defaultRuntime.log(
            [
              `agent=${health.agentId}`,
              `status=${health.status}`,
              `pauseReason=${health.pauseReason ?? "none"}`,
              `cycles=${health.metrics.cycles} (ok=${health.metrics.ok} error=${health.metrics.error} skipped=${health.metrics.skipped})`,
              `consecutiveErrors=${health.metrics.consecutiveErrors}`,
              `budget.day=${health.budget.dayKey}`,
              `budget.cycles=${health.budget.cyclesUsed}/${health.budget.cycleBudget ?? "unbounded"}`,
              `budget.tokens=${health.budget.tokensUsed}/${health.budget.tokenBudget ?? "unbounded"}`,
              ...(warnings.length > 0
                ? ["warnings:", ...warnings.map((warning) => `- ${warning}`)]
                : []),
            ].join("\n"),
          );
        } catch (err) {
          defaultRuntime.error(danger(String(err)));
          defaultRuntime.exit(1);
        }
      }),
  );

  addGatewayClientOptions(
    cron
      .command("autonomous-reset")
      .description("Reset autonomy runtime state/events for an agent")
      .requiredOption("--agent <id>", "Target agent id")
      .action(async (opts) => {
        try {
          const agentId = sanitizeAgentId(String(opts.agent));
          await resetAutonomyRuntime(agentId);
          defaultRuntime.log(`autonomy runtime reset for agent=${agentId}`);
        } catch (err) {
          defaultRuntime.error(danger(String(err)));
          defaultRuntime.exit(1);
        }
      }),
  );

  addGatewayClientOptions(
    cron
      .command("autonomous-tune")
      .description("Patch autonomy policy fields on an existing autonomous cron job")
      .argument("<id>", "Job id")
      .option("--mission <text>", "Update mission")
      .option("--goals-file <path>", "Update goals file path")
      .option("--tasks-file <path>", "Update tasks file path")
      .option("--log-file <path>", "Update log file path")
      .option("--max-actions <n>", "Update max actions per run")
      .option("--dedupe-window-minutes <n>", "Update dedupe window (minutes)")
      .option("--max-queued-events <n>", "Update max queued events")
      .option("--daily-token-budget <n>", "Update daily token budget")
      .option("--daily-cycle-budget <n>", "Update daily cycle budget")
      .option("--max-consecutive-errors <n>", "Update max consecutive errors")
      .option("--auto-pause-on-budget", "Enable auto-pause on budget exhaustion")
      .option("--no-auto-pause-on-budget", "Disable auto-pause on budget exhaustion")
      .option("--auto-resume-on-new-day-budget", "Enable auto-resume after budget day rollover")
      .option("--no-auto-resume-on-new-day-budget", "Disable auto-resume after budget day rollover")
      .option("--error-pause-minutes <n>", "Update error pause cooldown minutes")
      .option("--stale-task-hours <n>", "Update stale task threshold hours")
      .option("--emit-daily-review-events", "Enable daily review events")
      .option("--no-emit-daily-review-events", "Disable daily review events")
      .option("--emit-weekly-review-events", "Enable weekly review events")
      .option("--no-emit-weekly-review-events", "Disable weekly review events")
      .option("--pause", "Pause autonomy")
      .option("--resume", "Resume autonomy")
      .action(async (id, opts) => {
        try {
          if (opts.pause && opts.resume) {
            throw new Error("Use either --pause or --resume, not both");
          }
          const patchAutonomy: Record<string, unknown> = {};
          const mission = getTrimmedString(opts.mission);
          const goalsFile = getTrimmedString(opts.goalsFile);
          const tasksFile = getTrimmedString(opts.tasksFile);
          const logFile = getTrimmedString(opts.logFile);
          const maxActions = parsePositiveIntOrUndefined(opts.maxActions);
          const dedupeWindowMinutes = parsePositiveIntOrUndefined(opts.dedupeWindowMinutes);
          const maxQueuedEvents = parsePositiveIntOrUndefined(opts.maxQueuedEvents);
          const dailyTokenBudget = parsePositiveIntOrUndefined(opts.dailyTokenBudget);
          const dailyCycleBudget = parsePositiveIntOrUndefined(opts.dailyCycleBudget);
          const maxConsecutiveErrors = parsePositiveIntOrUndefined(opts.maxConsecutiveErrors);
          const errorPauseMinutes = parsePositiveIntOrUndefined(opts.errorPauseMinutes);
          const staleTaskHours = parsePositiveIntOrUndefined(opts.staleTaskHours);
          if (mission) {
            patchAutonomy.mission = mission;
          }
          if (goalsFile) {
            patchAutonomy.goalsFile = goalsFile;
          }
          if (tasksFile) {
            patchAutonomy.tasksFile = tasksFile;
          }
          if (logFile) {
            patchAutonomy.logFile = logFile;
          }
          if (maxActions) {
            patchAutonomy.maxActionsPerRun = maxActions;
          }
          if (dedupeWindowMinutes) {
            patchAutonomy.dedupeWindowMinutes = dedupeWindowMinutes;
          }
          if (maxQueuedEvents) {
            patchAutonomy.maxQueuedEvents = maxQueuedEvents;
          }
          if (dailyTokenBudget) {
            patchAutonomy.dailyTokenBudget = dailyTokenBudget;
          }
          if (dailyCycleBudget) {
            patchAutonomy.dailyCycleBudget = dailyCycleBudget;
          }
          if (maxConsecutiveErrors) {
            patchAutonomy.maxConsecutiveErrors = maxConsecutiveErrors;
          }
          if (errorPauseMinutes) {
            patchAutonomy.errorPauseMinutes = errorPauseMinutes;
          }
          if (staleTaskHours) {
            patchAutonomy.staleTaskHours = staleTaskHours;
          }
          if (opts.autoPauseOnBudget === true || opts.autoPauseOnBudget === false) {
            patchAutonomy.autoPauseOnBudgetExhausted = opts.autoPauseOnBudget;
          }
          if (opts.autoResumeOnNewDayBudget === true || opts.autoResumeOnNewDayBudget === false) {
            patchAutonomy.autoResumeOnNewDayBudgetPause = opts.autoResumeOnNewDayBudget;
          }
          if (opts.emitDailyReviewEvents === true || opts.emitDailyReviewEvents === false) {
            patchAutonomy.emitDailyReviewEvents = opts.emitDailyReviewEvents;
          }
          if (opts.emitWeeklyReviewEvents === true || opts.emitWeeklyReviewEvents === false) {
            patchAutonomy.emitWeeklyReviewEvents = opts.emitWeeklyReviewEvents;
          }
          if (opts.pause) {
            patchAutonomy.paused = true;
          }
          if (opts.resume) {
            patchAutonomy.paused = false;
          }
          if (Object.keys(patchAutonomy).length === 0) {
            throw new Error("No tune fields provided.");
          }
          const res = await callGatewayFromCli("cron.update", opts, {
            id,
            patch: {
              payload: {
                kind: "agentTurn",
                autonomy: patchAutonomy,
              },
            },
          });
          defaultRuntime.log(JSON.stringify(res, null, 2));
        } catch (err) {
          defaultRuntime.error(danger(String(err)));
          defaultRuntime.exit(1);
        }
      }),
  );

  addGatewayClientOptions(
    cron
      .command("autonomous-event")
      .description("Inject an external event into autonomy inbox (webhook/email/subagent/manual)")
      .requiredOption("--agent <id>", "Target agent id")
      .requiredOption("--type <type>", "Event type (e.g. webhook.received, email.received)")
      .option("--source <source>", "Event source (cron|webhook|email|subagent|manual)", "manual")
      .option("--dedupe-key <key>", "Optional dedupe key")
      .option("--payload <json>", "Optional JSON payload")
      .option("--json", "Output JSON", false)
      .action(async (opts) => {
        try {
          const agentId = sanitizeAgentId(String(opts.agent));
          const sourceRaw = getTrimmedString(opts.source) ?? "manual";
          if (!AUTONOMY_SOURCES.has(sourceRaw)) {
            throw new Error("--source must be cron|webhook|email|subagent|manual");
          }
          const type = getTrimmedString(opts.type);
          if (!type) {
            throw new Error("--type is required");
          }
          let payload: Record<string, unknown> | undefined;
          if (typeof opts.payload === "string" && opts.payload.trim()) {
            const parsed = JSON.parse(opts.payload) as unknown;
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
              payload = parsed as Record<string, unknown>;
            } else {
              throw new Error("--payload must be a JSON object");
            }
          }
          const event = await enqueueAutonomyEvent({
            agentId,
            source: sourceRaw as "cron" | "webhook" | "email" | "subagent" | "manual",
            type,
            dedupeKey: getTrimmedString(opts.dedupeKey),
            payload,
          });
          if (opts.json) {
            defaultRuntime.log(JSON.stringify({ ok: true, event }, null, 2));
            return;
          }
          defaultRuntime.log(
            `queued autonomy event for agent=${agentId}: ${event.source}/${event.type} (${event.id})`,
          );
        } catch (err) {
          defaultRuntime.error(danger(String(err)));
          defaultRuntime.exit(1);
        }
      }),
  );
}
