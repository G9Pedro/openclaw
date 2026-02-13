import type { Command } from "commander";
import type { CronJob } from "../../cron/types.js";
import type { GatewayRpcOpts } from "../gateway-rpc.js";
import {
  DEFAULT_AUTONOMY_GOALS_FILE,
  DEFAULT_AUTONOMY_LOG_FILE,
  DEFAULT_AUTONOMY_MISSION,
  DEFAULT_AUTONOMY_TASKS_FILE,
} from "../../agents/autonomy-primitives.js";
import { enqueueAutonomyEvent } from "../../autonomy/store.js";
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
