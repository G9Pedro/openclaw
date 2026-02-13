export const DEFAULT_AUTONOMY_MISSION =
  "Continuously pursue useful long-term goals, using real external signals and safe delegated execution.";
export const DEFAULT_AUTONOMY_GOALS_FILE = "AUTONOMY_GOALS.md";
export const DEFAULT_AUTONOMY_TASKS_FILE = "AUTONOMY_TASKS.md";
export const DEFAULT_AUTONOMY_LOG_FILE = "AUTONOMY_LOG.md";
export const DEFAULT_AUTONOMY_MAX_ACTIONS_PER_RUN = 3;

export type AutonomousPromptOptions = {
  mission?: string;
  goalsFile?: string;
  tasksFile?: string;
  logFile?: string;
  maxActionsPerRun?: number;
};

export function normalizeAutonomyText(value: string | undefined, fallback: string) {
  const trimmed = (value ?? "").trim();
  if (!trimmed) {
    return fallback;
  }
  return trimmed.replace(/\s+/g, " ");
}

export function normalizeAutonomyFilePath(value: string | undefined, fallback: string) {
  const trimmed = (value ?? "").trim();
  return trimmed || fallback;
}

export function normalizeAutonomyMaxActions(value: number | undefined) {
  if (!Number.isFinite(value)) {
    return DEFAULT_AUTONOMY_MAX_ACTIONS_PER_RUN;
  }
  return Math.max(1, Math.min(20, Math.floor(value as number)));
}

export function buildAutonomousCoordinationPrompt(opts: AutonomousPromptOptions) {
  const mission = normalizeAutonomyText(opts.mission, DEFAULT_AUTONOMY_MISSION);
  const goalsFile = normalizeAutonomyFilePath(opts.goalsFile, DEFAULT_AUTONOMY_GOALS_FILE);
  const tasksFile = normalizeAutonomyFilePath(opts.tasksFile, DEFAULT_AUTONOMY_TASKS_FILE);
  const logFile = normalizeAutonomyFilePath(opts.logFile, DEFAULT_AUTONOMY_LOG_FILE);
  const maxActions = normalizeAutonomyMaxActions(opts.maxActionsPerRun);

  const lines = [
    "You are the autonomous engine for this workspace.",
    "",
    "Mission:",
    `- ${mission}`,
    "",
    "You must operate using explicit coordination and task primitives.",
    "",
    "Coordination primitives:",
    "1) INGEST_SIGNALS: Gather fresh inputs from hooks/webhooks/email triggers, chat updates, and web tools.",
    "2) PLAN_CYCLE: Re-rank goals by impact, urgency, and feasibility.",
    "3) CLAIM_WORK: Pick top tasks that fit this run's budget.",
    "4) DELEGATE: Use sessions_spawn for parallelizable work with clear acceptance criteria.",
    "5) INTEGRATE: Pull results back (sessions_history, tool outputs), then update goals/tasks.",
    "6) REPORT: Publish concise progress, blockers, and next trigger decision.",
    "",
    "Task primitives (state machine):",
    "- CREATE_TASK(id, title, priority, owner, dependencies, evidence)",
    "- START_TASK(id, rationale)",
    "- BLOCK_TASK(id, blocker, unblock_plan)",
    "- COMPLETE_TASK(id, outcome, evidence)",
    "- CANCEL_TASK(id, reason)",
    "- ENQUEUE_FOLLOWUP(id, trigger_type, due_hint)",
    "",
    "Self-trigger primitives:",
    "- CRON_TICK: this run is a scheduled heartbeat for the engine.",
    "- WEBHOOK_OR_EMAIL_EVENT: convert event payloads into actionable tasks.",
    "- SUBAGENT_COMPLETION: ingest child outcomes and chain follow-up tasks.",
    "- WAKE_NOW: when urgent, use cron wake mode 'now' with a concise reason.",
    "",
    "Persistence contract (must update each run):",
    `- Goals file: ${goalsFile}`,
    `- Tasks file: ${tasksFile}`,
    `- Execution log: ${logFile}`,
    "",
    "Run protocol:",
    "1. Read goals/tasks/log files if they exist; create them if missing.",
    "2. Perform INGEST_SIGNALS and write a short evidence note to the log.",
    "3. Execute PLAN_CYCLE and choose up to the action budget.",
    `4. Execute at most ${maxActions} meaningful actions this run.`,
    "5. Delegate when it reduces latency or risk; avoid unnecessary fan-out.",
    "6. Update task states and append outcomes to the log.",
    "7. End with NEXT_TRIGGER containing what should wake you next and why.",
    "",
    "Safety constraints:",
    "- Do not run destructive or irreversible actions without explicit user authorization.",
    "- Prefer reversible, observable steps with clear rollback paths.",
    "- If no high-value action exists, record HEARTBEAT_OK with reason and stop.",
  ];
  return lines.join("\n");
}

export type AutonomousCycleContext = {
  nowIso: string;
  queuedEvents: Array<{ source: string; type: string; ts: number; dedupeKey?: string }>;
  recentCycleOutcomes: Array<{ ts: number; status: string; summary?: string }>;
  blockedTaskCount: number;
  inProgressTaskCount: number;
  pendingTaskCount: number;
  budget?: {
    dayKey: string;
    cyclesUsed: number;
    tokensUsed: number;
    dailyCycleBudget?: number;
    dailyTokenBudget?: number;
  };
};

export function buildAutonomousCyclePreamble(context: AutonomousCycleContext) {
  const lines = [
    "# Cycle Context",
    "",
    `Cycle started at: ${context.nowIso}`,
    `Queued signals: ${context.queuedEvents.length}`,
    `Tasks in progress: ${context.inProgressTaskCount}`,
    `Tasks blocked: ${context.blockedTaskCount}`,
    `Tasks pending: ${context.pendingTaskCount}`,
    "",
  ];
  if (context.budget) {
    const cycleBudget = context.budget.dailyCycleBudget ?? "unbounded";
    const tokenBudget = context.budget.dailyTokenBudget ?? "unbounded";
    lines.push(
      `Budget (${context.budget.dayKey}): cycles ${context.budget.cyclesUsed}/${cycleBudget}, tokens ${context.budget.tokensUsed}/${tokenBudget}`,
    );
    lines.push("");
  }
  if (context.queuedEvents.length > 0) {
    lines.push("Signals in this cycle:");
    for (const event of context.queuedEvents) {
      const atIso = new Date(event.ts).toISOString();
      const dedupe = event.dedupeKey ? ` (dedupe=${event.dedupeKey})` : "";
      lines.push(`- [${event.source}] ${event.type} at ${atIso}${dedupe}`);
    }
    lines.push("");
  }
  if (context.recentCycleOutcomes.length > 0) {
    lines.push("Recent cycle outcomes:");
    for (const cycle of context.recentCycleOutcomes.slice(-3)) {
      const atIso = new Date(cycle.ts).toISOString();
      const summary = cycle.summary ? ` - ${cycle.summary}` : "";
      lines.push(`- ${atIso}: ${cycle.status}${summary}`);
    }
    lines.push("");
  }
  lines.push("Apply coordination and task primitives strictly in this cycle.");
  return lines.join("\n");
}
