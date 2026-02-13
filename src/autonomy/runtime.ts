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
  if (typeof autonomyCfg?.paused === "boolean") {
    state.paused = autonomyCfg.paused;
  }

  if (state.paused) {
    await saveAutonomyState(state);
    return { skipped: true, reason: "autonomy paused", state };
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
}) {
  const endedAt = Date.now();
  recordAutonomyCycle(params.state, {
    ts: endedAt,
    status: params.status,
    summary: params.summary,
    error: params.error,
    processedEvents: params.events.length,
    durationMs: Math.max(0, endedAt - params.cycleStartedAt),
  });
  await appendAutonomyWorkspaceLog({
    workspaceDir: params.workspaceDir,
    logFile: params.state.logFile,
    nowMs: endedAt,
    status: params.status,
    summary: params.summary,
    error: params.error,
    processedEvents: params.events,
    droppedDuplicates: params.droppedDuplicates,
    remainingEvents: params.remainingEvents,
  });
  await saveAutonomyState(params.state);
}
