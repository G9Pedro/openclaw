import type { Command } from "commander";
import type { GatewayRpcOpts } from "../gateway-rpc.js";
import { buildAutonomousCoordinationPrompt } from "../../agents/autonomy-primitives.js";
import { danger } from "../../globals.js";
import { sanitizeAgentId } from "../../routing/session-key.js";
import { defaultRuntime } from "../../runtime.js";
import { addGatewayClientOptions, callGatewayFromCli } from "../gateway-rpc.js";
import { parsePositiveIntOrUndefined } from "../program/helpers.js";
import { getCronChannelOptions, parseDurationMs, warnIfCronSchedulerDisabled } from "./shared.js";

const DEFAULT_AUTONOMOUS_NAME = "Autonomous engine";
const DEFAULT_AUTONOMOUS_CADENCE = "10m";
const DEFAULT_AUTONOMOUS_MISSION =
  "Continuously discover, prioritize, and execute high-impact goals using external signals and delegated work.";

function getTrimmedString(value: unknown) {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
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
      .option("--goals-file <path>", "Path for persistent goals file", "AUTONOMY_GOALS.md")
      .option("--tasks-file <path>", "Path for persistent tasks file", "AUTONOMY_TASKS.md")
      .option("--log-file <path>", "Path for persistent execution log", "AUTONOMY_LOG.md")
      .option("--max-actions <n>", "Max meaningful actions per run", "3")
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
          const mission = getTrimmedString(opts.mission) ?? DEFAULT_AUTONOMOUS_MISSION;
          const goalsFile = getTrimmedString(opts.goalsFile) ?? "AUTONOMY_GOALS.md";
          const tasksFile = getTrimmedString(opts.tasksFile) ?? "AUTONOMY_TASKS.md";
          const logFile = getTrimmedString(opts.logFile) ?? "AUTONOMY_LOG.md";
          const prompt = buildAutonomousCoordinationPrompt({
            mission,
            goalsFile,
            tasksFile,
            logFile,
            maxActionsPerRun: maxActions,
          });

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
              message: prompt,
              model: getTrimmedString(opts.model),
              thinking: getTrimmedString(opts.thinking),
              timeoutSeconds:
                timeoutSeconds && Number.isFinite(timeoutSeconds) ? timeoutSeconds : undefined,
              deliver: opts.deliver ? true : undefined,
              channel: typeof opts.channel === "string" ? opts.channel : "last",
              to: getTrimmedString(opts.to),
              bestEffortDeliver: opts.bestEffortDeliver ? true : undefined,
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
}
