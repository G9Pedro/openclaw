import { describe, expect, it } from "vitest";
import type { AutonomyState } from "./types.js";
import {
  transitionAugmentationStage,
  resolveExecutionClassForStage,
} from "./runtime.phase-machine.js";

function buildState(): AutonomyState {
  const nowMs = Date.now();
  return {
    version: 1,
    agentId: "ops",
    mission: "mission",
    paused: false,
    goalsFile: "AUTONOMY_GOALS.md",
    tasksFile: "AUTONOMY_TASKS.md",
    logFile: "AUTONOMY_LOG.md",
    maxActionsPerRun: 3,
    dedupeWindowMs: 60_000,
    maxQueuedEvents: 100,
    safety: {
      maxConsecutiveErrors: 5,
      autoPauseOnBudgetExhausted: true,
      autoResumeOnNewDayBudgetPause: true,
      errorPauseMinutes: 240,
      staleTaskHours: 24,
      emitDailyReviewEvents: true,
      emitWeeklyReviewEvents: true,
    },
    budget: {
      dayKey: "2026-02-13",
      cyclesUsed: 0,
      tokensUsed: 0,
    },
    review: {},
    augmentation: {
      stage: "discover",
      stageEnteredAt: nowMs,
      lastTransitionAt: nowMs,
      phaseRunCount: 0,
      policyVersion: "2026-02-13",
      gaps: [],
      candidates: [],
      activeExperiments: [],
      transitions: [],
    },
    taskSignals: {},
    dedupe: {},
    goals: [],
    tasks: [],
    recentEvents: [],
    recentCycles: [],
    metrics: {
      cycles: 0,
      ok: 0,
      error: 0,
      skipped: 0,
      consecutiveErrors: 0,
    },
  };
}

describe("autonomy phase machine", () => {
  it("transitions only to next stage", () => {
    const state = buildState();
    const moved = transitionAugmentationStage(state, "design", "has gaps", Date.now());
    expect(moved.changed).toBe(true);
    expect(state.augmentation.stage).toBe("design");
    expect(state.augmentation.transitions).toHaveLength(1);
  });

  it("rejects invalid transitions", () => {
    const state = buildState();
    expect(() => transitionAugmentationStage(state, "verify", "skip", Date.now())).toThrow(
      /invalid augmentation stage transition/,
    );
  });

  it("maps stage to execution class", () => {
    expect(resolveExecutionClassForStage("discover")).toBe("read_only");
    expect(resolveExecutionClassForStage("verify")).toBe("reversible_write");
    expect(resolveExecutionClassForStage("promote")).toBe("destructive");
  });
});
