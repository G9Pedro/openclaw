import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("autonomy runtime", () => {
  let tmpDir = "";
  let workspaceDir = "";
  let priorStateDir: string | undefined;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-autonomy-runtime-"));
    workspaceDir = path.join(tmpDir, "workspace");
    await fs.mkdir(workspaceDir, { recursive: true });
    priorStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = path.join(tmpDir, "state");
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

  it("skips execution when autonomy payload marks paused", async () => {
    const runtime = await import("./runtime.js");
    const prepared = await runtime.prepareAutonomyRuntime({
      agentId: "ops",
      workspaceDir,
      autonomy: {
        enabled: true,
        paused: true,
      },
    });
    expect("skipped" in prepared && prepared.skipped).toBe(true);
    if ("skipped" in prepared) {
      expect(prepared.reason).toContain("paused");
    }
  });

  it("injects queued events and writes cycle log on finalize", async () => {
    const store = await import("./store.js");
    const runtime = await import("./runtime.js");

    await store.enqueueAutonomyEvent({
      agentId: "ops",
      source: "email",
      type: "email.received",
      dedupeKey: "mail:123",
      payload: { subject: "hello" },
    });

    const prepared = await runtime.prepareAutonomyRuntime({
      agentId: "ops",
      workspaceDir,
      autonomy: {
        enabled: true,
        mission: "Handle inbound signals continuously",
      },
    });
    if ("skipped" in prepared) {
      throw new Error("expected non-skipped prepare result");
    }
    expect(prepared.events.some((event) => event.type === "cron.tick")).toBe(true);
    expect(prepared.events.some((event) => event.type === "email.received")).toBe(true);

    await runtime.finalizeAutonomyRuntime({
      workspaceDir,
      state: prepared.state,
      cycleStartedAt: prepared.cycleStartedAt,
      status: "ok",
      summary: "cycle done",
      events: prepared.events,
      droppedDuplicates: prepared.droppedDuplicates,
      remainingEvents: prepared.remainingEvents,
      usage: {
        input: 200,
        output: 100,
        total: 300,
      },
    });

    const reloaded = await store.loadAutonomyState({ agentId: "ops" });
    expect(reloaded.metrics.cycles).toBe(1);
    expect(reloaded.metrics.ok).toBe(1);
    expect(reloaded.budget.tokensUsed).toBeGreaterThanOrEqual(300);
    expect(reloaded.recentEvents.length).toBeGreaterThan(0);
    const logPath = path.join(workspaceDir, reloaded.logFile);
    const logText = await fs.readFile(logPath, "utf-8");
    expect(logText).toContain("cycle done");
    expect(logText).toContain("email.received");
  });

  it("skips execution when daily cycle budget is exhausted", async () => {
    const store = await import("./store.js");
    const runtime = await import("./runtime.js");
    const state = await store.loadAutonomyState({ agentId: "ops" });
    state.budget.cyclesUsed = 3;
    state.safety.dailyCycleBudget = 3;
    await store.saveAutonomyState(state);

    const prepared = await runtime.prepareAutonomyRuntime({
      agentId: "ops",
      workspaceDir,
      autonomy: {
        enabled: true,
      },
    });
    expect("skipped" in prepared && prepared.skipped).toBe(true);
    if ("skipped" in prepared) {
      expect(prepared.reason).toContain("daily cycle budget exhausted");
      expect(prepared.state.paused).toBe(true);
    }
  });

  it("auto-pauses when consecutive error threshold is reached", async () => {
    const store = await import("./store.js");
    const runtime = await import("./runtime.js");
    const prepared = await runtime.prepareAutonomyRuntime({
      agentId: "ops",
      workspaceDir,
      autonomy: {
        enabled: true,
        maxConsecutiveErrors: 2,
      },
    });
    if ("skipped" in prepared) {
      throw new Error("expected non-skipped prepare result");
    }
    await runtime.finalizeAutonomyRuntime({
      workspaceDir,
      state: prepared.state,
      cycleStartedAt: prepared.cycleStartedAt,
      status: "error",
      error: "boom-1",
      events: prepared.events,
      droppedDuplicates: prepared.droppedDuplicates,
      remainingEvents: prepared.remainingEvents,
    });

    const preparedSecond = await runtime.prepareAutonomyRuntime({
      agentId: "ops",
      workspaceDir,
      autonomy: {
        enabled: true,
        maxConsecutiveErrors: 2,
      },
    });
    if ("skipped" in preparedSecond) {
      throw new Error("expected non-skipped second prepare");
    }
    await runtime.finalizeAutonomyRuntime({
      workspaceDir,
      state: preparedSecond.state,
      cycleStartedAt: preparedSecond.cycleStartedAt,
      status: "error",
      error: "boom-2",
      events: preparedSecond.events,
      droppedDuplicates: preparedSecond.droppedDuplicates,
      remainingEvents: preparedSecond.remainingEvents,
    });
    const reloaded = await store.loadAutonomyState({ agentId: "ops" });
    expect(reloaded.paused).toBe(true);
    expect(reloaded.metrics.consecutiveErrors).toBeGreaterThanOrEqual(2);
  });
});
