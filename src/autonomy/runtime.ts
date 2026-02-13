import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
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
import { emitDiagnosticEvent } from "../infra/diagnostic-events.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { evaluateCanaryHealth } from "./canary/manager.js";
import { upsertGapRegistry } from "./discovery/gap-registry.js";
import { normalizeAutonomySignals } from "./discovery/signal-normalizer.js";
import { evaluatePromotionGates } from "./eval/gates.js";
import {
  createAugmentationPhaseEnterEvent,
  createAugmentationPhaseExitEvent,
  createAugmentationPolicyDeniedEvent,
  createCanaryEvaluationEvent,
  createCandidatesUpdatedEvent,
  createDiscoveryUpdatedEvent,
} from "./events.js";
import { appendAutonomyLedgerEntry } from "./ledger/store.js";
import {
  createDefaultAutonomyPolicyConfig,
  evaluateAutonomyPolicy,
  resolveAutonomyActionClass,
} from "./policy/runtime.js";
import {
  resolveExecutionClassForStage,
  resolveNextAugmentationStage,
  transitionAugmentationStage,
} from "./runtime.phase-machine.js";
import { planSkillCandidates } from "./skill-forge/planner.js";
import { synthesizeSkillCandidates } from "./skill-forge/synthesizer.js";
import { verifySkillCandidates } from "./skill-forge/verify.js";
import {
  applyAutonomyPause,
  appendAutonomyWorkspaceLog,
  clearAutonomyPause,
  drainAutonomyEvents,
  ensureAutonomyWorkspaceFiles,
  loadAutonomyState,
  recordAutonomyCycle,
  recordAutonomyEvents,
  refreshAutonomyBudgetWindow,
  resolveAutonomyLockPath,
  resolveIsoWeekKey,
  saveAutonomyState,
} from "./store.js";

export type AutonomyRuntimePrepared = {
  state: AutonomyState;
  prompt: string;
  events: AutonomyEvent[];
  droppedDuplicates: number;
  droppedInvalid: number;
  droppedOverflow: number;
  remainingEvents: number;
  cycleStartedAt: number;
  lockToken: string;
};

export type AutonomyUsageSnapshot = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  total?: number;
};

const RUN_LOCK_TTL_MS = 6 * 60 * 60_000;
const activeRuns = new Map<string, { token: string; expiresAt: number }>();

function parseRunLock(raw: string) {
  if (!raw.trim()) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as { token?: unknown; expiresAt?: unknown };
    if (typeof parsed.token !== "string" || !parsed.token.trim()) {
      return null;
    }
    if (typeof parsed.expiresAt !== "number" || !Number.isFinite(parsed.expiresAt)) {
      return null;
    }
    return {
      token: parsed.token,
      expiresAt: Math.max(0, Math.floor(parsed.expiresAt)),
    };
  } catch {
    return null;
  }
}

async function tryCreateRunLockFile(lockPath: string, payload: string) {
  try {
    const handle = await fs.open(lockPath, "wx");
    try {
      await handle.writeFile(payload, "utf-8");
    } finally {
      await handle.close();
    }
    return true;
  } catch (error) {
    if ((error as { code?: string }).code === "EEXIST") {
      return false;
    }
    throw error;
  }
}

async function acquireAutonomyRunLock(agentId: string, nowMs: number): Promise<string | null> {
  const active = activeRuns.get(agentId);
  if (active && active.expiresAt > nowMs) {
    return null;
  }
  if (active && active.expiresAt <= nowMs) {
    activeRuns.delete(agentId);
  }

  const lockPath = resolveAutonomyLockPath(agentId);
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const rawLock = await fs.readFile(lockPath, "utf-8").catch(() => "");
    const parsedLock = parseRunLock(rawLock);
    if (parsedLock && parsedLock.expiresAt > nowMs) {
      return null;
    }
    if (rawLock.trim()) {
      await fs.rm(lockPath, { force: true }).catch(() => undefined);
    }
    const token = crypto.randomUUID();
    const expiresAt = nowMs + RUN_LOCK_TTL_MS;
    const payload = JSON.stringify(
      {
        token,
        acquiredAt: nowMs,
        expiresAt,
      },
      null,
      2,
    );
    const created = await tryCreateRunLockFile(lockPath, payload);
    if (!created) {
      continue;
    }
    activeRuns.set(agentId, { token, expiresAt });
    return token;
  }
  return null;
}

export async function releaseAutonomyRunLock(agentId: string, token: string) {
  const active = activeRuns.get(agentId);
  if (active && active.token === token) {
    activeRuns.delete(agentId);
  }

  const lockPath = resolveAutonomyLockPath(agentId);
  const rawLock = await fs.readFile(lockPath, "utf-8").catch(() => "");
  const parsedLock = parseRunLock(rawLock);
  if (!parsedLock || parsedLock.token === token || parsedLock.expiresAt <= Date.now()) {
    await fs.rm(lockPath, { force: true }).catch(() => undefined);
  }
}

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

function resolveDayKey(nowMs: number) {
  return new Date(nowMs).toISOString().slice(0, 10);
}

function buildSyntheticAutonomyEvents(params: {
  state: AutonomyState;
  nowMs: number;
  dayKey: string;
}): AutonomyEvent[] {
  const events: AutonomyEvent[] = [];
  const weekKey = resolveIsoWeekKey(params.nowMs);
  if (
    params.state.safety.emitDailyReviewEvents &&
    params.state.review.lastDailyReviewDayKey !== params.dayKey
  ) {
    events.push({
      id: `daily-review-${params.dayKey}`,
      source: "cron",
      type: "autonomy.review.daily",
      ts: params.nowMs,
      dedupeKey: `autonomy.review.daily:${params.dayKey}`,
    });
    params.state.review.lastDailyReviewDayKey = params.dayKey;
  }
  if (
    params.state.safety.emitWeeklyReviewEvents &&
    params.state.review.lastWeeklyReviewKey !== weekKey
  ) {
    events.push({
      id: `weekly-review-${weekKey}`,
      source: "cron",
      type: "autonomy.review.weekly",
      ts: params.nowMs,
      dedupeKey: `autonomy.review.weekly:${weekKey}`,
    });
    params.state.review.lastWeeklyReviewKey = weekKey;
  }

  const staleMs = params.state.safety.staleTaskHours * 60 * 60_000;
  if (staleMs > 0) {
    const trackedIds = new Set(params.state.tasks.map((task) => task.id));
    for (const task of params.state.tasks) {
      if (task.status !== "blocked" && task.status !== "in_progress") {
        continue;
      }
      if (params.nowMs - task.updatedAt < staleMs) {
        continue;
      }
      if (params.state.taskSignals[task.id] === params.dayKey) {
        continue;
      }
      const ageHours = Math.floor((params.nowMs - task.updatedAt) / 3_600_000);
      events.push({
        id: `stale-${task.id}-${params.dayKey}`,
        source: "manual",
        type: `autonomy.task.stale.${task.status}`,
        ts: params.nowMs,
        dedupeKey: `autonomy.task.stale:${task.id}:${params.dayKey}`,
        payload: {
          taskId: task.id,
          title: task.title,
          status: task.status,
          ageHours,
        },
      });
      params.state.taskSignals[task.id] = params.dayKey;
    }
    for (const taskId of Object.keys(params.state.taskSignals)) {
      if (!trackedIds.has(taskId)) {
        delete params.state.taskSignals[taskId];
      }
    }
  }
  return events;
}

function normalizePluginSignalEvents(params: {
  nowMs: number;
  events: Array<{
    source?: "cron" | "webhook" | "email" | "subagent" | "manual";
    type: string;
    dedupeKey?: string;
    payload?: Record<string, unknown>;
  }>;
}) {
  return params.events
    .map((event, index): AutonomyEvent | null => {
      if (typeof event.type !== "string" || !event.type.trim()) {
        return null;
      }
      return {
        id: `plugin-signal-${params.nowMs}-${index}`,
        source: event.source ?? "manual",
        type: event.type.trim(),
        ts: params.nowMs,
        dedupeKey:
          typeof event.dedupeKey === "string" && event.dedupeKey.trim()
            ? event.dedupeKey
            : undefined,
        payload:
          event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
            ? event.payload
            : undefined,
      };
    })
    .filter((event): event is AutonomyEvent => event !== null);
}

function resolveRecentCanaryStatus(state: AutonomyState): "healthy" | "regressed" | undefined {
  for (let index = state.recentEvents.length - 1; index >= 0; index -= 1) {
    const event = state.recentEvents[index];
    if (!event || event.type !== "autonomy.augmentation.canary.evaluated") {
      continue;
    }
    const status = event.payload?.status;
    if (status === "healthy" || status === "regressed") {
      return status;
    }
  }
  return undefined;
}

async function processAugmentationCycle(params: {
  state: AutonomyState;
  nowMs: number;
  events: AutonomyEvent[];
  workspaceDir: string;
}) {
  const correlationId = `cycle-${params.nowMs}`;
  const augmentationEvents: AutonomyEvent[] = [];
  params.state.augmentation.phaseRunCount += 1;

  const hookRunner = getGlobalHookRunner();
  let pluginSignalEvents: AutonomyEvent[] = [];
  if (hookRunner?.hasHooks("autonomy_signal")) {
    const hookResult = await hookRunner.runAutonomySignal(
      {
        events: params.events.map((event) => ({
          source: event.source,
          type: event.type,
          ts: event.ts,
          dedupeKey: event.dedupeKey,
          payload: event.payload,
        })),
      },
      {
        agentId: params.state.agentId,
        workspaceDir: params.workspaceDir,
        stage: params.state.augmentation.stage,
        nowMs: params.nowMs,
      },
    );
    pluginSignalEvents = normalizePluginSignalEvents({
      nowMs: params.nowMs,
      events: hookResult?.events ?? [],
    });
  }
  augmentationEvents.push(...pluginSignalEvents);

  const signals = normalizeAutonomySignals([...params.events, ...pluginSignalEvents]);
  if (signals.length > 0) {
    params.state.augmentation.gaps = upsertGapRegistry({
      gaps: params.state.augmentation.gaps,
      signals,
      nowMs: params.nowMs,
    });
    const discoveryEvent = createDiscoveryUpdatedEvent({
      nowMs: params.nowMs,
      signals: signals.length,
      openGaps: params.state.augmentation.gaps.filter((gap) => gap.status === "open").length,
    });
    augmentationEvents.push(discoveryEvent);
    await appendAutonomyLedgerEntry({
      agentId: params.state.agentId,
      correlationId,
      eventType: "discovery_update",
      stage: params.state.augmentation.stage,
      actor: "autonomy-runtime",
      summary: `processed ${signals.length} discovery signals`,
      evidence: {
        signalCount: signals.length,
        pluginSignalCount: pluginSignalEvents.length,
        openGapCount: params.state.augmentation.gaps.filter((gap) => gap.status === "open").length,
      },
      ts: params.nowMs,
    });
  }

  const planned = planSkillCandidates({
    nowMs: params.nowMs,
    gaps: params.state.augmentation.gaps,
    existingCandidates: params.state.augmentation.candidates,
  });
  if (planned.generatedCount > 0) {
    params.state.augmentation.candidates = planned.candidates;
    const candidatesEvent = createCandidatesUpdatedEvent({
      nowMs: params.nowMs,
      generated: planned.generatedCount,
      totalCandidates: params.state.augmentation.candidates.length,
    });
    augmentationEvents.push(candidatesEvent);
    await appendAutonomyLedgerEntry({
      agentId: params.state.agentId,
      correlationId,
      eventType: "candidate_update",
      stage: params.state.augmentation.stage,
      actor: "skill-planner",
      summary: `generated ${planned.generatedCount} skill candidate(s)`,
      evidence: {
        generatedCount: planned.generatedCount,
        totalCandidates: params.state.augmentation.candidates.length,
      },
      ts: params.nowMs,
    });
  }

  const stageBeforeActions = params.state.augmentation.stage;
  if (stageBeforeActions === "synthesize") {
    const synthesized = await synthesizeSkillCandidates({
      workspaceDir: params.workspaceDir,
      candidates: params.state.augmentation.candidates,
    });
    if (synthesized.synthesized > 0) {
      params.state.augmentation.candidates = synthesized.candidates;
      const candidatesEvent = createCandidatesUpdatedEvent({
        nowMs: params.nowMs,
        generated: synthesized.synthesized,
        totalCandidates: params.state.augmentation.candidates.length,
      });
      augmentationEvents.push(candidatesEvent);
      await appendAutonomyLedgerEntry({
        agentId: params.state.agentId,
        correlationId,
        eventType: "candidate_update",
        stage: params.state.augmentation.stage,
        actor: "skill-synthesizer",
        summary: `synthesized ${synthesized.synthesized} skill file(s)`,
        evidence: {
          synthesized: synthesized.synthesized,
        },
        ts: params.nowMs,
      });
    }
  }

  if (stageBeforeActions === "verify") {
    const verified = await verifySkillCandidates({
      workspaceDir: params.workspaceDir,
      candidates: params.state.augmentation.candidates,
    });
    if (verified.reports.length > 0) {
      params.state.augmentation.candidates = verified.candidates;
      await appendAutonomyLedgerEntry({
        agentId: params.state.agentId,
        correlationId,
        eventType: "candidate_update",
        stage: params.state.augmentation.stage,
        actor: "skill-verifier",
        summary: `verified ${verified.reports.length} candidate(s)`,
        evidence: {
          reports: verified.reports.map((report) => ({
            candidateId: report.candidateId,
            ok: report.ok,
            failures: report.failures,
          })),
        },
        ts: params.nowMs,
      });
    }
  }

  if (stageBeforeActions === "canary") {
    const recentCycles = params.state.recentCycles.slice(-5);
    const actionable = recentCycles.filter((cycle) => cycle.status !== "skipped");
    const errorRate =
      actionable.length > 0
        ? actionable.filter((cycle) => cycle.status === "error").length / actionable.length
        : 0;
    const latencies = actionable
      .map((cycle) => cycle.durationMs)
      .filter((duration): duration is number => Number.isFinite(duration))
      .toSorted((a, b) => a - b);
    const latencyP95Ms =
      latencies.length > 0
        ? latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95))]
        : 0;
    const baselineLatencyP95Ms =
      latencies.length > 0 ? latencies[Math.floor((latencies.length - 1) / 2)] : 0;
    const canary = evaluateCanaryHealth({
      errorRate,
      maxErrorRate: 0.05,
      latencyP95Ms,
      baselineLatencyP95Ms,
      maxLatencyRegressionPct: 50,
    });
    augmentationEvents.push(
      createCanaryEvaluationEvent({
        nowMs: params.nowMs,
        status: canary.status,
        reason: canary.reason,
        errorRate,
        latencyP95Ms,
      }),
    );
    if (canary.shouldRollback) {
      params.state.augmentation.candidates = params.state.augmentation.candidates.map((candidate) =>
        candidate.status === "verified"
          ? { ...candidate, status: "rejected", updatedAt: params.nowMs }
          : candidate,
      );
      await appendAutonomyLedgerEntry({
        agentId: params.state.agentId,
        correlationId,
        eventType: "rollback",
        stage: params.state.augmentation.stage,
        actor: "canary-manager",
        summary: canary.reason,
        evidence: {
          errorRate,
          latencyP95Ms,
          baselineLatencyP95Ms,
        },
        ts: params.nowMs,
      });
    } else {
      await appendAutonomyLedgerEntry({
        agentId: params.state.agentId,
        correlationId,
        eventType: "promotion",
        stage: params.state.augmentation.stage,
        actor: "canary-manager",
        summary: canary.reason,
        evidence: {
          errorRate,
          latencyP95Ms,
          baselineLatencyP95Ms,
        },
        ts: params.nowMs,
      });
    }
  }

  let nextStage = resolveNextAugmentationStage(params.state);
  let skipPolicyCheck = false;
  if (stageBeforeActions === "promote") {
    const recentCycles = params.state.recentCycles.slice(-5);
    const actionable = recentCycles.filter((cycle) => cycle.status !== "skipped");
    const recentErrorCount = actionable.filter((cycle) => cycle.status === "error").length;
    const verifiedCandidateCount = params.state.augmentation.candidates.filter(
      (candidate) => candidate.status === "verified",
    ).length;
    const gate = evaluatePromotionGates({
      verifiedCandidateCount,
      recentCycleCount: actionable.length,
      recentErrorCount,
      canaryStatus: resolveRecentCanaryStatus(params.state),
    });
    if (!gate.passed) {
      nextStage = stageBeforeActions;
      skipPolicyCheck = true;
      const deniedEvent = createAugmentationPolicyDeniedEvent({
        stage: stageBeforeActions,
        executionClass: "destructive",
        nowMs: params.nowMs,
        reason: gate.reason,
      });
      augmentationEvents.push(deniedEvent);
      emitDiagnosticEvent({
        type: "autonomy.phase",
        agentId: params.state.agentId,
        stage: stageBeforeActions,
        action: "blocked",
        reason: gate.reason,
        lane: "autonomy",
        gapCount: params.state.augmentation.gaps.length,
        candidateCount: params.state.augmentation.candidates.length,
        durationMs: 0,
      });
      await appendAutonomyLedgerEntry({
        agentId: params.state.agentId,
        correlationId,
        eventType: "policy_denied",
        stage: stageBeforeActions,
        actor: "promotion-gates",
        summary: gate.reason,
        evidence: {
          verifiedCandidateCount,
          recentCycleCount: actionable.length,
          recentErrorCount,
          errorRate: gate.errorRate,
        },
        ts: params.nowMs,
      });
    }
  }

  if (!skipPolicyCheck) {
    const action = `autonomy.stage.${nextStage}`;
    const policyConfig = createDefaultAutonomyPolicyConfig({
      version: params.state.augmentation.policyVersion,
    });
    const executionClass = resolveAutonomyActionClass({
      action,
      fallbackClass: resolveExecutionClassForStage(nextStage),
      config: policyConfig,
    });
    const policyDecision = evaluateAutonomyPolicy({
      action,
      executionClass,
      config: policyConfig,
      approvedByOperator: false,
    });

    if (!policyDecision.allowed) {
      const deniedEvent = createAugmentationPolicyDeniedEvent({
        stage: nextStage,
        executionClass,
        nowMs: params.nowMs,
        reason: policyDecision.reason,
      });
      augmentationEvents.push(deniedEvent);
      emitDiagnosticEvent({
        type: "autonomy.phase",
        agentId: params.state.agentId,
        stage: nextStage,
        action: "blocked",
        reason: policyDecision.reason,
        lane: "autonomy",
        gapCount: params.state.augmentation.gaps.length,
        candidateCount: params.state.augmentation.candidates.length,
        durationMs: 0,
      });
      await appendAutonomyLedgerEntry({
        agentId: params.state.agentId,
        correlationId,
        eventType: "policy_denied",
        stage: nextStage,
        actor: "policy-runtime",
        summary: policyDecision.reason,
        evidence: {
          action,
          executionClass,
          policyVersion: policyDecision.policyVersion,
        },
        ts: params.nowMs,
      });
      return augmentationEvents;
    }
  }

  const currentStage = params.state.augmentation.stage;
  if (currentStage !== nextStage) {
    transitionAugmentationStage(params.state, nextStage, "phase progression", params.nowMs);
    const exitEvent = createAugmentationPhaseExitEvent({
      stage: currentStage,
      nowMs: params.nowMs,
      reason: "phase progression",
    });
    const enterEvent = createAugmentationPhaseEnterEvent({
      stage: nextStage,
      nowMs: params.nowMs,
      reason: "phase progression",
    });
    augmentationEvents.push(exitEvent, enterEvent);
    emitDiagnosticEvent({
      type: "autonomy.phase",
      agentId: params.state.agentId,
      stage: currentStage,
      action: "exit",
      reason: "phase progression",
      lane: "autonomy",
      gapCount: params.state.augmentation.gaps.length,
      candidateCount: params.state.augmentation.candidates.length,
      durationMs: Math.max(0, params.nowMs - params.state.augmentation.stageEnteredAt),
    });
    emitDiagnosticEvent({
      type: "autonomy.phase",
      agentId: params.state.agentId,
      stage: nextStage,
      action: "enter",
      reason: "phase progression",
      lane: "autonomy",
      gapCount: params.state.augmentation.gaps.length,
      candidateCount: params.state.augmentation.candidates.length,
      durationMs: 0,
    });
    await appendAutonomyLedgerEntry({
      agentId: params.state.agentId,
      correlationId,
      eventType: "phase_exit",
      stage: currentStage,
      actor: "phase-machine",
      summary: `exited ${currentStage}`,
      evidence: {
        to: nextStage,
      },
      ts: params.nowMs,
    });
    await appendAutonomyLedgerEntry({
      agentId: params.state.agentId,
      correlationId,
      eventType: "phase_enter",
      stage: nextStage,
      actor: "phase-machine",
      summary: `entered ${nextStage}`,
      evidence: {
        from: currentStage,
      },
      ts: params.nowMs,
    });
  }

  return augmentationEvents;
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
        autoResumeOnNewDayBudgetPause: autonomyCfg?.autoResumeOnNewDayBudgetPause,
        errorPauseMinutes: autonomyCfg?.errorPauseMinutes,
        staleTaskHours: autonomyCfg?.staleTaskHours,
        emitDailyReviewEvents: autonomyCfg?.emitDailyReviewEvents,
        emitWeeklyReviewEvents: autonomyCfg?.emitWeeklyReviewEvents,
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
    if (typeof autonomyCfg.autoResumeOnNewDayBudgetPause === "boolean") {
      state.safety.autoResumeOnNewDayBudgetPause = autonomyCfg.autoResumeOnNewDayBudgetPause;
    }
    if (Number.isFinite(autonomyCfg.errorPauseMinutes)) {
      state.safety.errorPauseMinutes = Math.max(
        1,
        Math.min(24 * 60, Math.floor(autonomyCfg.errorPauseMinutes as number)),
      );
    }
    if (Number.isFinite(autonomyCfg.staleTaskHours)) {
      state.safety.staleTaskHours = Math.max(
        1,
        Math.min(24 * 30, Math.floor(autonomyCfg.staleTaskHours as number)),
      );
    }
    if (typeof autonomyCfg.emitDailyReviewEvents === "boolean") {
      state.safety.emitDailyReviewEvents = autonomyCfg.emitDailyReviewEvents;
    }
    if (typeof autonomyCfg.emitWeeklyReviewEvents === "boolean") {
      state.safety.emitWeeklyReviewEvents = autonomyCfg.emitWeeklyReviewEvents;
    }
  }
  if (typeof autonomyCfg?.paused === "boolean") {
    if (autonomyCfg.paused) {
      applyAutonomyPause(state, "manual", nowMs);
    } else {
      clearAutonomyPause(state);
    }
  }
  const budgetRolled = refreshAutonomyBudgetWindow(state, nowMs);
  const sameDayBudgetFresh =
    state.budget.dayKey === resolveDayKey(nowMs) &&
    state.budget.cyclesUsed === 0 &&
    state.budget.tokensUsed === 0;

  let resumedReason: string | undefined;
  if (
    state.paused &&
    state.pauseReason === "budget" &&
    (budgetRolled || sameDayBudgetFresh) &&
    state.safety.autoResumeOnNewDayBudgetPause
  ) {
    clearAutonomyPause(state);
    resumedReason = "budget-window-rollover";
  }
  if (
    state.paused &&
    state.pauseReason === "errors" &&
    typeof state.pausedAt === "number" &&
    nowMs - state.pausedAt >= state.safety.errorPauseMinutes * 60_000
  ) {
    clearAutonomyPause(state);
    resumedReason = "error-cooldown-elapsed";
  }

  if (state.paused) {
    const reason = state.pauseReason ? `autonomy paused (${state.pauseReason})` : "autonomy paused";
    await saveAutonomyState(state);
    return { skipped: true, reason, state };
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
      applyAutonomyPause(state, "budget", nowMs);
    }
    const reason = reasons.join("; ");
    await saveAutonomyState(state);
    return { skipped: true, reason, state };
  }

  const lockToken = await acquireAutonomyRunLock(state.agentId, nowMs);
  if (!lockToken) {
    await saveAutonomyState(state);
    return { skipped: true, reason: "autonomy run already in progress", state };
  }
  try {
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
    const syntheticEvents = buildSyntheticAutonomyEvents({
      state,
      nowMs,
      dayKey: state.budget.dayKey,
    });
    const resumeEvent: AutonomyEvent[] = resumedReason
      ? [
          {
            id: `resume-${resumedReason}-${nowMs}`,
            source: "manual",
            type: "autonomy.resume",
            ts: nowMs,
            dedupeKey: `autonomy.resume:${resumedReason}:${Math.floor(nowMs / 60_000)}`,
            payload: { reason: resumedReason },
          },
        ]
      : [];
    const queueHealthEvents: AutonomyEvent[] = [];
    if (drained.droppedOverflow > 0) {
      queueHealthEvents.push({
        id: `queue-overflow-${nowMs}`,
        source: "manual",
        type: "autonomy.queue.overflow",
        ts: nowMs,
        dedupeKey: `autonomy.queue.overflow:${state.budget.dayKey}`,
        payload: {
          droppedOverflow: drained.droppedOverflow,
        },
      });
    }
    if (drained.droppedInvalid > 0) {
      queueHealthEvents.push({
        id: `queue-invalid-${nowMs}`,
        source: "manual",
        type: "autonomy.queue.invalid",
        ts: nowMs,
        dedupeKey: `autonomy.queue.invalid:${Math.floor(nowMs / 60_000)}`,
        payload: {
          droppedInvalid: drained.droppedInvalid,
        },
      });
    }
    const runtimeEvents = [
      cycleEvent,
      ...resumeEvent,
      ...queueHealthEvents,
      ...syntheticEvents,
      ...drained.events,
    ];
    const augmentationEvents = await processAugmentationCycle({
      state,
      nowMs,
      events: runtimeEvents,
      workspaceDir: params.workspaceDir,
    });
    const events = [...runtimeEvents, ...augmentationEvents];
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
      augmentation: {
        stage: state.augmentation.stage,
        gaps: state.augmentation.gaps.length,
        candidates: state.augmentation.candidates.length,
      },
    });
    await saveAutonomyState(state);
    return {
      state,
      prompt: `${basePrompt}\n\n${preamble}`.trim(),
      events,
      droppedDuplicates: drained.droppedDuplicates,
      droppedInvalid: drained.droppedInvalid,
      droppedOverflow: drained.droppedOverflow,
      remainingEvents: drained.remaining,
      cycleStartedAt: nowMs,
      lockToken,
    };
  } catch (error) {
    await releaseAutonomyRunLock(state.agentId, lockToken);
    throw error;
  }
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
  droppedInvalid?: number;
  droppedOverflow?: number;
  remainingEvents: number;
  usage?: AutonomyUsageSnapshot;
  lockToken?: string;
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
  try {
    const autoPausedForErrors =
      params.state.metrics.consecutiveErrors >= params.state.safety.maxConsecutiveErrors &&
      !params.state.paused;
    if (autoPausedForErrors) {
      applyAutonomyPause(params.state, "errors", endedAt);
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
      droppedInvalid: params.droppedInvalid,
      droppedOverflow: params.droppedOverflow,
      remainingEvents: params.remainingEvents,
      budgetDayKey: params.state.budget.dayKey,
      budgetCyclesUsed: params.state.budget.cyclesUsed,
      budgetTokensUsed: params.state.budget.tokensUsed,
    });
    await saveAutonomyState(params.state);
  } finally {
    if (typeof params.lockToken === "string") {
      await releaseAutonomyRunLock(params.state.agentId, params.lockToken);
    }
  }
}
