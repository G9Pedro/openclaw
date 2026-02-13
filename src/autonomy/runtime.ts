import type { CronAutonomyConfig } from "../cron/types.js";
import type { AutonomyEvent, AutonomyState } from "./types.js";
import {
  buildAutonomousCoordinationPrompt,
  buildAutonomousCyclePreamble,
  DEFAULT_AUTONOMY_GOALS_FILE,
  DEFAULT_AUTONOMY_LOG_FILE,
  DEFAULT_AUTONOMY_MAX_ACTIONS_PER_RUN,
  DEFAULT_AUTONOMY_MISSION,
  DEFAULT_AUTONOMY_TASKS_FILE,
  normalizeAutonomyFilePath,
  normalizeAutonomyMaxActions,
  normalizeAutonomyText,
} from "../agents/autonomy-primitives.js";
import {
  appendAutonomyWorkspaceLog,
  drainAutonomyEvents,
  ensureAutonomyWorkspaceFiles,
  loadAutonomyState,
  recordAutonomyCycle,
  recordAutonomyEvents,
  refreshAutonomyBudgetWindow,
  saveAutonomyState,
} from "./store.js";

export type AutonomyRuntimePrepared = {
  state: AutonomyState;
  prompt: string;
  events: AutonomyEvent[];
  droppedDuplicates: number;
  remainingEvents: number;
  cycleStartedAt: number;
};

export type AutonomyUsageSnapshot = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  total?: number;
};

function normalizeDedupeWindowMs(minutes: number | undefined, fallbackMs: number) {
  if (!Number.isFinite(minutes)) {
    return fallbackMs;
  }
  const asMs = Math.floor((minutes as number) * 60_000);
  return Math.max(60_000, Math.min(24 * 60 * 60_000, asMs));
}

function normalizeMaxQueuedEvents(value: number | undefined, fallback: number) {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(1, Math.min(500, Math.floor(value as number)));
}

function normalizeOptionalPositiveInt(value: number | undefined) {
  if (!Number.isFinite(value)) {
    return undefined;
  }
  return Math.max(1, Math.floor(value as number));
}

export async function prepareAutonomyRuntime(params: {
  agentId: string;
  workspaceDir: string;
  autonomy?: CronAutonomyConfig;
}): Promise<AutonomyRuntimePrepared | { skipped: true; reason: string; state: AutonomyState }> {
  const nowMs = Date.now();
  const autonomyCfg = params.autonomy;
  const state = await loadAutonomyState({
    agentId: params.agentId,
    defaults: {
      mission: autonomyCfg?.mission,
      goalsFile: autonomyCfg?.goalsFile,
      tasksFile: autonomyCfg?.tasksFile,
      logFile: autonomyCfg?.logFile,
      maxActionsPerRun: autonomyCfg?.maxActionsPerRun,
      dedupeWindowMs: normalizeDedupeWindowMs(autonomyCfg?.dedupeWindowMinutes, 60 * 60_000),
      maxQueuedEvents: autonomyCfg?.maxQueuedEvents,
      paused: autonomyCfg?.paused,
      safety: {
        dailyTokenBudget: autonomyCfg?.dailyTokenBudget,
        dailyCycleBudget: autonomyCfg?.dailyCycleBudget,
        maxConsecutiveErrors: autonomyCfg?.maxConsecutiveErrors,
        autoPauseOnBudgetExhausted: autonomyCfg?.autoPauseOnBudgetExhausted,
      },
    },
  });

  // Keep runtime state synced with latest cron payload overrides.
  state.mission = normalizeAutonomyText(
    autonomyCfg?.mission,
    state.mission || DEFAULT_AUTONOMY_MISSION,
  );
  state.goalsFile = normalizeAutonomyFilePath(
    autonomyCfg?.goalsFile,
    state.goalsFile || DEFAULT_AUTONOMY_GOALS_FILE,
  );
  state.tasksFile = normalizeAutonomyFilePath(
    autonomyCfg?.tasksFile,
    state.tasksFile || DEFAULT_AUTONOMY_TASKS_FILE,
  );
  state.logFile = normalizeAutonomyFilePath(
    autonomyCfg?.logFile,
    state.logFile || DEFAULT_AUTONOMY_LOG_FILE,
  );
  state.maxActionsPerRun = normalizeAutonomyMaxActions(
    autonomyCfg?.maxActionsPerRun ?? state.maxActionsPerRun ?? DEFAULT_AUTONOMY_MAX_ACTIONS_PER_RUN,
  );
  state.dedupeWindowMs = normalizeDedupeWindowMs(
    autonomyCfg?.dedupeWindowMinutes,
    state.dedupeWindowMs,
  );
  state.maxQueuedEvents = normalizeMaxQueuedEvents(
    autonomyCfg?.maxQueuedEvents,
    state.maxQueuedEvents,
  );
  if (autonomyCfg) {
    if (autonomyCfg.dailyTokenBudget !== undefined) {
      state.safety.dailyTokenBudget = normalizeOptionalPositiveInt(autonomyCfg.dailyTokenBudget);
    }
    if (autonomyCfg.dailyCycleBudget !== undefined) {
      state.safety.dailyCycleBudget = normalizeOptionalPositiveInt(autonomyCfg.dailyCycleBudget);
    }
    if (Number.isFinite(autonomyCfg.maxConsecutiveErrors)) {
      state.safety.maxConsecutiveErrors = Math.max(
        1,
        Math.min(100, Math.floor(autonomyCfg.maxConsecutiveErrors as number)),
      );
    }
    if (typeof autonomyCfg.autoPauseOnBudgetExhausted === "boolean") {
      state.safety.autoPauseOnBudgetExhausted = autonomyCfg.autoPauseOnBudgetExhausted;
    }
  }
  if (typeof autonomyCfg?.paused === "boolean") {
    state.paused = autonomyCfg.paused;
  }
  refreshAutonomyBudgetWindow(state, nowMs);

  if (state.paused) {
    await saveAutonomyState(state);
    return { skipped: true, reason: "autonomy paused", state };
  }
  const cycleBudget = state.safety.dailyCycleBudget;
  const tokenBudget = state.safety.dailyTokenBudget;
  const exhaustedCycleBudget =
    typeof cycleBudget === "number" && state.budget.cyclesUsed >= cycleBudget;
  const exhaustedTokenBudget =
    typeof tokenBudget === "number" && state.budget.tokensUsed >= tokenBudget;
  if (exhaustedCycleBudget || exhaustedTokenBudget) {
    const reasons: string[] = [];
    if (exhaustedCycleBudget) {
      reasons.push(`daily cycle budget exhausted (${state.budget.cyclesUsed}/${cycleBudget})`);
    }
    if (exhaustedTokenBudget) {
      reasons.push(`daily token budget exhausted (${state.budget.tokensUsed}/${tokenBudget})`);
    }
    if (state.safety.autoPauseOnBudgetExhausted) {
      state.paused = true;
    }
    const reason = reasons.join("; ");
    await saveAutonomyState(state);
    return { skipped: true, reason, state };
  }

  await ensureAutonomyWorkspaceFiles({
    workspaceDir: params.workspaceDir,
    state,
  });
  const drained = await drainAutonomyEvents({
    agentId: params.agentId,
    state,
    maxEvents: state.maxQueuedEvents,
    nowMs,
  });
  const cycleEvent: AutonomyEvent = {
    id: `cron-${nowMs}`,
    source: "cron",
    type: "cron.tick",
    ts: nowMs,
    dedupeKey: `cron.tick:${Math.floor(nowMs / 60_000)}`,
  };
  const events = [cycleEvent, ...drained.events];
  recordAutonomyEvents(state, events);

  const basePrompt = buildAutonomousCoordinationPrompt({
    mission: state.mission,
    goalsFile: state.goalsFile,
    tasksFile: state.tasksFile,
    logFile: state.logFile,
    maxActionsPerRun: state.maxActionsPerRun,
  });
  const preamble = buildAutonomousCyclePreamble({
    nowIso: new Date(nowMs).toISOString(),
    queuedEvents: events.map((event) => ({
      source: event.source,
      type: event.type,
      ts: event.ts,
      dedupeKey: event.dedupeKey,
    })),
    recentCycleOutcomes: state.recentCycles.map((cycle) => ({
      ts: cycle.ts,
      status: cycle.status,
      summary: cycle.summary,
    })),
    blockedTaskCount: state.tasks.filter((task) => task.status === "blocked").length,
    inProgressTaskCount: state.tasks.filter((task) => task.status === "in_progress").length,
    pendingTaskCount: state.tasks.filter((task) => task.status === "pending").length,
    budget: {
      dayKey: state.budget.dayKey,
      cyclesUsed: state.budget.cyclesUsed,
      tokensUsed: state.budget.tokensUsed,
      dailyCycleBudget: state.safety.dailyCycleBudget,
      dailyTokenBudget: state.safety.dailyTokenBudget,
    },
  });
  await saveAutonomyState(state);
  return {
    state,
    prompt: `${basePrompt}\n\n${preamble}`.trim(),
    events,
    droppedDuplicates: drained.droppedDuplicates,
    remainingEvents: drained.remaining,
    cycleStartedAt: nowMs,
  };
}

export async function finalizeAutonomyRuntime(params: {
  workspaceDir: string;
  state: AutonomyState;
  cycleStartedAt: number;
  status: "ok" | "error" | "skipped";
  summary?: string;
  error?: string;
  events: AutonomyEvent[];
  droppedDuplicates: number;
  remainingEvents: number;
  usage?: AutonomyUsageSnapshot;
}) {
  const endedAt = Date.now();
  const usage = params.usage;
  const tokenUsage = {
    input: Number.isFinite(usage?.input) ? Math.max(0, Math.floor(usage?.input as number)) : 0,
    output: Number.isFinite(usage?.output) ? Math.max(0, Math.floor(usage?.output as number)) : 0,
    cacheRead: Number.isFinite(usage?.cacheRead)
      ? Math.max(0, Math.floor(usage?.cacheRead as number))
      : 0,
    cacheWrite: Number.isFinite(usage?.cacheWrite)
      ? Math.max(0, Math.floor(usage?.cacheWrite as number))
      : 0,
    total: Number.isFinite(usage?.total) ? Math.max(0, Math.floor(usage?.total as number)) : 0,
  };
  if (tokenUsage.total <= 0) {
    tokenUsage.total =
      tokenUsage.input + tokenUsage.output + tokenUsage.cacheRead + tokenUsage.cacheWrite;
  }
  recordAutonomyCycle(params.state, {
    ts: endedAt,
    status: params.status,
    summary: params.summary,
    error: params.error,
    processedEvents: params.events.length,
    durationMs: Math.max(0, endedAt - params.cycleStartedAt),
    tokenUsage,
  });
  const autoPausedForErrors =
    params.state.metrics.consecutiveErrors >= params.state.safety.maxConsecutiveErrors &&
    !params.state.paused;
  if (autoPausedForErrors) {
    params.state.paused = true;
  }
  await appendAutonomyWorkspaceLog({
    workspaceDir: params.workspaceDir,
    logFile: params.state.logFile,
    nowMs: endedAt,
    status: params.status,
    summary: autoPausedForErrors
      ? `${params.summary ?? "cycle complete"} (autonomy auto-paused after consecutive errors)`
      : params.summary,
    error: params.error,
    processedEvents: params.events,
    droppedDuplicates: params.droppedDuplicates,
    remainingEvents: params.remainingEvents,
    budgetDayKey: params.state.budget.dayKey,
    budgetCyclesUsed: params.state.budget.cyclesUsed,
    budgetTokensUsed: params.state.budget.tokensUsed,
  });
  await saveAutonomyState(params.state);
}
