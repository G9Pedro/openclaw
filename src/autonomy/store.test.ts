import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("autonomy store", () => {
  let tmpDir = "";
  let priorStateDir: string | undefined;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-autonomy-"));
    priorStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = tmpDir;
    vi.resetModules();
  });

  afterEach(async () => {
    if (priorStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = priorStateDir;
    }
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("loads default state and persists it", async () => {
    const store = await import("./store.js");
    const state = await store.loadAutonomyState({ agentId: "ops" });
    expect(state.agentId).toBe("ops");
    expect(state.metrics.cycles).toBe(0);
    expect(state.metrics.consecutiveErrors).toBe(0);
    expect(state.paused).toBe(false);
    expect(state.safety.maxConsecutiveErrors).toBe(5);
    expect(state.safety.autoResumeOnNewDayBudgetPause).toBe(true);
    expect(state.safety.errorPauseMinutes).toBe(240);
    expect(state.safety.staleTaskHours).toBe(24);
    expect(state.safety.emitDailyReviewEvents).toBe(true);
    expect(state.safety.emitWeeklyReviewEvents).toBe(true);
    expect(state.budget.cyclesUsed).toBe(0);
    expect(state.review.lastDailyReviewDayKey).toBeUndefined();
    expect(state.review.lastWeeklyReviewKey).toBeUndefined();
    expect(state.taskSignals).toEqual({});

    const statePath = store.resolveAutonomyStatePath("ops");
    const raw = await fs.readFile(statePath, "utf-8");
    expect(raw).toContain('"agentId": "ops"');
  });

  it("deduplicates queued events within dedupe window", async () => {
    const store = await import("./store.js");
    const state = await store.loadAutonomyState({
      agentId: "ops",
      defaults: { dedupeWindowMs: 60_000, maxQueuedEvents: 10 },
    });
    await store.enqueueAutonomyEvent({
      agentId: "ops",
      source: "manual",
      type: "task.created",
      dedupeKey: "task-1",
    });
    await store.enqueueAutonomyEvent({
      agentId: "ops",
      source: "manual",
      type: "task.created",
      dedupeKey: "task-1",
    });
    await store.enqueueAutonomyEvent({
      agentId: "ops",
      source: "manual",
      type: "task.created",
      dedupeKey: "task-2",
    });

    const drained = await store.drainAutonomyEvents({
      agentId: "ops",
      state,
      nowMs: 1_000_000,
    });
    expect(drained.events.map((event) => event.dedupeKey)).toEqual(["task-1", "task-2"]);
    expect(drained.droppedDuplicates).toBe(1);

    const drainedAgain = await store.drainAutonomyEvents({
      agentId: "ops",
      state,
      nowMs: 1_000_100,
    });
    expect(drainedAgain.events).toHaveLength(0);
  });

  it("recovers from backup when primary state file is corrupted", async () => {
    const store = await import("./store.js");
    const state = await store.loadAutonomyState({ agentId: "ops" });
    state.mission = "recover mission";
    await store.saveAutonomyState(state);

    await fs.writeFile(store.resolveAutonomyStatePath("ops"), "{not-json", "utf-8");

    const recovered = await store.loadAutonomyState({ agentId: "ops" });
    expect(recovered.mission).toBe("recover mission");
  });

  it("drops overflow and invalid queue entries while retaining recent signals", async () => {
    const store = await import("./store.js");
    const state = await store.loadAutonomyState({
      agentId: "ops",
      defaults: { maxQueuedEvents: 2 },
    });
    const eventsPath = store.resolveAutonomyEventsPath("ops");
    await fs.mkdir(path.dirname(eventsPath), { recursive: true });
    const lines = Array.from({ length: 5005 }, (_, index) =>
      JSON.stringify({
        id: `evt-${index}`,
        source: "manual",
        type: "task.created",
        ts: 1_000 + index,
        dedupeKey: `k-${index}`,
      }),
    );
    lines.splice(20, 0, "{broken-json");
    await fs.writeFile(eventsPath, `${lines.join("\n")}\n`, "utf-8");

    const drained = await store.drainAutonomyEvents({
      agentId: "ops",
      state,
      nowMs: 2_000_000,
    });
    expect(drained.events).toHaveLength(2);
    expect(drained.droppedOverflow).toBeGreaterThan(0);
    expect(drained.droppedInvalid).toBeGreaterThan(0);
    expect(drained.remaining).toBeGreaterThan(0);
  });

  it("records cycles and writes markdown run log", async () => {
    const store = await import("./store.js");
    const state = await store.loadAutonomyState({ agentId: "ops" });
    store.recordAutonomyCycle(state, {
      ts: 1_000_000,
      status: "ok",
      summary: "completed planning cycle",
      processedEvents: 2,
      durationMs: 800,
      tokenUsage: {
        input: 10,
        output: 5,
        cacheRead: 0,
        cacheWrite: 0,
        total: 15,
      },
    });
    expect(state.metrics.cycles).toBe(1);
    expect(state.metrics.ok).toBe(1);
    expect(state.budget.tokensUsed).toBeGreaterThanOrEqual(15);
    expect(state.budget.cyclesUsed).toBe(1);

    store.recordAutonomyCycle(state, {
      ts: 1_000_001,
      status: "skipped",
      summary: "paused",
      processedEvents: 0,
      durationMs: 0,
    });
    expect(state.metrics.skipped).toBe(1);
    expect(state.budget.cyclesUsed).toBe(1);

    const workspaceDir = path.join(tmpDir, "workspace");
    await store.ensureAutonomyWorkspaceFiles({ workspaceDir, state });
    await store.appendAutonomyWorkspaceLog({
      workspaceDir,
      logFile: state.logFile,
      nowMs: 1_000_100,
      status: "ok",
      summary: "cycle complete",
      processedEvents: [],
      droppedDuplicates: 0,
      remainingEvents: 0,
    });
    const logPath = path.join(workspaceDir, state.logFile);
    const logText = await fs.readFile(logPath, "utf-8");
    expect(logText).toContain("cycle complete");
  });

  it("resets runtime folder for an agent", async () => {
    const store = await import("./store.js");
    await store.loadAutonomyState({ agentId: "ops" });
    expect(await store.hasAutonomyState("ops")).toBe(true);
    await store.resetAutonomyRuntime("ops");
    expect(await store.hasAutonomyState("ops")).toBe(false);
  });
});
