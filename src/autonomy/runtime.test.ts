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
    const hooksGlobal = await import("../plugins/hook-runner-global.js");
    hooksGlobal.resetGlobalHookRunner();
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
      lockToken: prepared.lockToken,
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
      expect(prepared.state.pauseReason).toBe("budget");
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
      lockToken: prepared.lockToken,
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
      lockToken: preparedSecond.lockToken,
    });
    const reloaded = await store.loadAutonomyState({ agentId: "ops" });
    expect(reloaded.paused).toBe(true);
    expect(reloaded.pauseReason).toBe("errors");
    expect(reloaded.metrics.consecutiveErrors).toBeGreaterThanOrEqual(2);
  });

  it("auto-resumes budget pause on new day and injects resume signal", async () => {
    const store = await import("./store.js");
    const runtime = await import("./runtime.js");
    const state = await store.loadAutonomyState({ agentId: "ops" });
    state.paused = true;
    state.pauseReason = "budget";
    state.pausedAt = Date.now() - 3_600_000;
    state.budget.dayKey = "2000-01-01";
    state.budget.cyclesUsed = 99;
    state.budget.tokensUsed = 99_000;
    await store.saveAutonomyState(state);

    const prepared = await runtime.prepareAutonomyRuntime({
      agentId: "ops",
      workspaceDir,
      autonomy: { enabled: true },
    });
    if ("skipped" in prepared) {
      throw new Error("expected budget pause to auto-resume");
    }
    expect(prepared.state.paused).toBe(false);
    expect(prepared.events.some((event) => event.type === "autonomy.resume")).toBe(true);
    expect(prepared.state.budget.cyclesUsed).toBe(0);

    await runtime.finalizeAutonomyRuntime({
      workspaceDir,
      state: prepared.state,
      cycleStartedAt: prepared.cycleStartedAt,
      status: "ok",
      summary: "resume-ok",
      events: prepared.events,
      droppedDuplicates: prepared.droppedDuplicates,
      remainingEvents: prepared.remainingEvents,
      lockToken: prepared.lockToken,
    });
  });

  it("emits daily/weekly review only once per period", async () => {
    const runtime = await import("./runtime.js");

    const first = await runtime.prepareAutonomyRuntime({
      agentId: "ops",
      workspaceDir,
      autonomy: { enabled: true },
    });
    if ("skipped" in first) {
      throw new Error("expected first run to execute");
    }
    expect(first.events.some((event) => event.type === "autonomy.review.daily")).toBe(true);
    expect(first.events.some((event) => event.type === "autonomy.review.weekly")).toBe(true);
    await runtime.finalizeAutonomyRuntime({
      workspaceDir,
      state: first.state,
      cycleStartedAt: first.cycleStartedAt,
      status: "ok",
      summary: "first",
      events: first.events,
      droppedDuplicates: first.droppedDuplicates,
      remainingEvents: first.remainingEvents,
      lockToken: first.lockToken,
    });

    const second = await runtime.prepareAutonomyRuntime({
      agentId: "ops",
      workspaceDir,
      autonomy: { enabled: true },
    });
    if ("skipped" in second) {
      throw new Error("expected second run to execute");
    }
    expect(second.events.some((event) => event.type === "autonomy.review.daily")).toBe(false);
    expect(second.events.some((event) => event.type === "autonomy.review.weekly")).toBe(false);
    await runtime.finalizeAutonomyRuntime({
      workspaceDir,
      state: second.state,
      cycleStartedAt: second.cycleStartedAt,
      status: "ok",
      summary: "second",
      events: second.events,
      droppedDuplicates: second.droppedDuplicates,
      remainingEvents: second.remainingEvents,
      lockToken: second.lockToken,
    });
  });

  it("emits stale task signals and dedupes them per day", async () => {
    const store = await import("./store.js");
    const runtime = await import("./runtime.js");
    const state = await store.loadAutonomyState({ agentId: "ops" });
    state.tasks = [
      {
        id: "t-1",
        title: "Long blocked task",
        status: "blocked",
        priority: "high",
        dependencies: [],
        owner: "autonomy",
        createdAt: Date.now() - 72 * 3_600_000,
        updatedAt: Date.now() - 48 * 3_600_000,
      },
    ];
    await store.saveAutonomyState(state);

    const first = await runtime.prepareAutonomyRuntime({
      agentId: "ops",
      workspaceDir,
      autonomy: { enabled: true, staleTaskHours: 24 },
    });
    if ("skipped" in first) {
      throw new Error("expected stale task run to execute");
    }
    expect(first.events.some((event) => event.type === "autonomy.task.stale.blocked")).toBe(true);
    await runtime.finalizeAutonomyRuntime({
      workspaceDir,
      state: first.state,
      cycleStartedAt: first.cycleStartedAt,
      status: "ok",
      events: first.events,
      droppedDuplicates: first.droppedDuplicates,
      remainingEvents: first.remainingEvents,
      lockToken: first.lockToken,
    });

    const second = await runtime.prepareAutonomyRuntime({
      agentId: "ops",
      workspaceDir,
      autonomy: { enabled: true, staleTaskHours: 24 },
    });
    if ("skipped" in second) {
      throw new Error("expected second stale run to execute");
    }
    expect(second.events.some((event) => event.type === "autonomy.task.stale.blocked")).toBe(false);
    await runtime.finalizeAutonomyRuntime({
      workspaceDir,
      state: second.state,
      cycleStartedAt: second.cycleStartedAt,
      status: "ok",
      events: second.events,
      droppedDuplicates: second.droppedDuplicates,
      remainingEvents: second.remainingEvents,
      lockToken: second.lockToken,
    });
  });

  it("prevents overlapping runs with per-agent runtime lock", async () => {
    const runtime = await import("./runtime.js");
    const first = await runtime.prepareAutonomyRuntime({
      agentId: "ops",
      workspaceDir,
      autonomy: { enabled: true },
    });
    if ("skipped" in first) {
      throw new Error("expected first lock attempt to succeed");
    }

    const second = await runtime.prepareAutonomyRuntime({
      agentId: "ops",
      workspaceDir,
      autonomy: { enabled: true },
    });
    expect("skipped" in second && second.skipped).toBe(true);
    if ("skipped" in second) {
      expect(second.reason).toContain("already in progress");
    }

    await runtime.finalizeAutonomyRuntime({
      workspaceDir,
      state: first.state,
      cycleStartedAt: first.cycleStartedAt,
      status: "ok",
      events: first.events,
      droppedDuplicates: first.droppedDuplicates,
      remainingEvents: first.remainingEvents,
      lockToken: first.lockToken,
    });
  });

  it("skips run when a non-stale lock file already exists", async () => {
    const store = await import("./store.js");
    const runtime = await import("./runtime.js");
    const lockPath = store.resolveAutonomyLockPath("ops");
    await fs.mkdir(path.dirname(lockPath), { recursive: true });
    await fs.writeFile(
      lockPath,
      JSON.stringify({
        token: "external-token",
        acquiredAt: Date.now() - 1000,
        expiresAt: Date.now() + 60_000,
      }),
      "utf-8",
    );

    const prepared = await runtime.prepareAutonomyRuntime({
      agentId: "ops",
      workspaceDir,
      autonomy: { enabled: true },
    });
    expect("skipped" in prepared && prepared.skipped).toBe(true);
    if ("skipped" in prepared) {
      expect(prepared.reason).toContain("already in progress");
    }
  });

  it("clears stale lock file and continues cycle", async () => {
    const store = await import("./store.js");
    const runtime = await import("./runtime.js");
    const lockPath = store.resolveAutonomyLockPath("ops");
    await fs.mkdir(path.dirname(lockPath), { recursive: true });
    await fs.writeFile(
      lockPath,
      JSON.stringify({
        token: "stale-token",
        acquiredAt: Date.now() - 8 * 60 * 60_000,
        expiresAt: Date.now() - 1000,
      }),
      "utf-8",
    );

    const prepared = await runtime.prepareAutonomyRuntime({
      agentId: "ops",
      workspaceDir,
      autonomy: { enabled: true },
    });
    if ("skipped" in prepared) {
      throw new Error("expected stale lock to be recoverable");
    }

    await runtime.finalizeAutonomyRuntime({
      workspaceDir,
      state: prepared.state,
      cycleStartedAt: prepared.cycleStartedAt,
      status: "ok",
      events: prepared.events,
      droppedDuplicates: prepared.droppedDuplicates,
      droppedInvalid: prepared.droppedInvalid,
      droppedOverflow: prepared.droppedOverflow,
      remainingEvents: prepared.remainingEvents,
      lockToken: prepared.lockToken,
    });

    const lockStillExists = await fs
      .access(lockPath)
      .then(() => true)
      .catch(() => false);
    expect(lockStillExists).toBe(false);
  });

  it("injects queue resilience signals for invalid/overflow events", async () => {
    const store = await import("./store.js");
    const runtime = await import("./runtime.js");
    const eventsPath = store.resolveAutonomyEventsPath("ops");
    await fs.mkdir(path.dirname(eventsPath), { recursive: true });
    const queuedLines = Array.from({ length: 5005 }, (_, index) =>
      JSON.stringify({
        id: `evt-${index}`,
        source: "manual",
        type: "work.signal",
        ts: 1_000 + index,
        dedupeKey: `work-${index}`,
      }),
    );
    queuedLines.push("{bad-json");
    await fs.writeFile(eventsPath, `${queuedLines.join("\n")}\n`, "utf-8");

    const prepared = await runtime.prepareAutonomyRuntime({
      agentId: "ops",
      workspaceDir,
      autonomy: { enabled: true, maxQueuedEvents: 1 },
    });
    if ("skipped" in prepared) {
      throw new Error("expected run to execute");
    }
    expect(prepared.events.some((event) => event.type === "autonomy.queue.overflow")).toBe(true);
    expect(prepared.events.some((event) => event.type === "autonomy.queue.invalid")).toBe(true);
    expect(prepared.droppedOverflow).toBeGreaterThan(0);
    expect(prepared.droppedInvalid).toBeGreaterThan(0);

    await runtime.finalizeAutonomyRuntime({
      workspaceDir,
      state: prepared.state,
      cycleStartedAt: prepared.cycleStartedAt,
      status: "ok",
      events: prepared.events,
      droppedDuplicates: prepared.droppedDuplicates,
      droppedInvalid: prepared.droppedInvalid,
      droppedOverflow: prepared.droppedOverflow,
      remainingEvents: prepared.remainingEvents,
      lockToken: prepared.lockToken,
    });
  });

  it("updates augmentation discovery/candidate state from runtime events", async () => {
    const runtime = await import("./runtime.js");
    const prepared = await runtime.prepareAutonomyRuntime({
      agentId: "ops",
      workspaceDir,
      autonomy: { enabled: true },
    });
    if ("skipped" in prepared) {
      throw new Error("expected run to execute");
    }
    expect(
      prepared.events.some((event) => event.type === "autonomy.augmentation.discovery.updated"),
    ).toBe(true);
    expect(prepared.state.augmentation.phaseRunCount).toBeGreaterThan(0);

    await runtime.finalizeAutonomyRuntime({
      workspaceDir,
      state: prepared.state,
      cycleStartedAt: prepared.cycleStartedAt,
      status: "ok",
      events: prepared.events,
      droppedDuplicates: prepared.droppedDuplicates,
      droppedInvalid: prepared.droppedInvalid,
      droppedOverflow: prepared.droppedOverflow,
      remainingEvents: prepared.remainingEvents,
      lockToken: prepared.lockToken,
    });
  });

  it("denies destructive augmentation phase transition without approval", async () => {
    const store = await import("./store.js");
    const runtime = await import("./runtime.js");
    const state = await store.loadAutonomyState({ agentId: "ops" });
    state.augmentation.stage = "canary";
    state.augmentation.candidates = [
      {
        id: "candidate-1",
        sourceGapId: "gap-1",
        name: "autonomy-candidate-1",
        intent: "test promote phase",
        status: "verified",
        priority: 100,
        createdAt: Date.now() - 1000,
        updatedAt: Date.now() - 1000,
        safety: {
          executionClass: "reversible_write",
          constraints: ["must be reversible"],
        },
        tests: ["unit"],
      },
    ];
    await store.saveAutonomyState(state);

    const prepared = await runtime.prepareAutonomyRuntime({
      agentId: "ops",
      workspaceDir,
      autonomy: { enabled: true },
    });
    if ("skipped" in prepared) {
      throw new Error("expected run to execute");
    }
    expect(prepared.state.augmentation.stage).toBe("canary");
    expect(
      prepared.events.some((event) => event.type === "autonomy.augmentation.policy.denied"),
    ).toBe(true);

    await runtime.finalizeAutonomyRuntime({
      workspaceDir,
      state: prepared.state,
      cycleStartedAt: prepared.cycleStartedAt,
      status: "ok",
      events: prepared.events,
      droppedDuplicates: prepared.droppedDuplicates,
      droppedInvalid: prepared.droppedInvalid,
      droppedOverflow: prepared.droppedOverflow,
      remainingEvents: prepared.remainingEvents,
      lockToken: prepared.lockToken,
    });
  });

  it("synthesizes and verifies generated skills through augmentation stages", async () => {
    const store = await import("./store.js");
    const runtime = await import("./runtime.js");
    const state = await store.loadAutonomyState({ agentId: "ops" });
    state.augmentation.stage = "synthesize";
    state.augmentation.candidates = [
      {
        id: "candidate-1",
        sourceGapId: "gap-1",
        name: "autonomy-stage-skill",
        intent: "exercise skill forge",
        status: "candidate",
        priority: 100,
        createdAt: Date.now() - 1000,
        updatedAt: Date.now() - 1000,
        safety: {
          executionClass: "reversible_write",
          constraints: ["must be reversible and observable"],
        },
        tests: ["unit: addresses gap gap-1"],
      },
    ];
    await store.saveAutonomyState(state);

    const synthesized = await runtime.prepareAutonomyRuntime({
      agentId: "ops",
      workspaceDir,
      autonomy: { enabled: true },
    });
    if ("skipped" in synthesized) {
      throw new Error("expected synthesized run to execute");
    }
    const generatedPath = path.join(
      workspaceDir,
      "skills",
      "autonomy-generated",
      "autonomy-stage-skill.md",
    );
    const generatedContent = await fs.readFile(generatedPath, "utf-8");
    expect(generatedContent).toContain("## Safety constraints");
    expect(synthesized.state.augmentation.candidates[0]?.status).toBe("planned");
    await runtime.finalizeAutonomyRuntime({
      workspaceDir,
      state: synthesized.state,
      cycleStartedAt: synthesized.cycleStartedAt,
      status: "ok",
      events: synthesized.events,
      droppedDuplicates: synthesized.droppedDuplicates,
      droppedInvalid: synthesized.droppedInvalid,
      droppedOverflow: synthesized.droppedOverflow,
      remainingEvents: synthesized.remainingEvents,
      lockToken: synthesized.lockToken,
    });

    const reloaded = await store.loadAutonomyState({ agentId: "ops" });
    reloaded.augmentation.stage = "verify";
    await store.saveAutonomyState(reloaded);
    const verified = await runtime.prepareAutonomyRuntime({
      agentId: "ops",
      workspaceDir,
      autonomy: { enabled: true },
    });
    if ("skipped" in verified) {
      throw new Error("expected verify run to execute");
    }
    expect(
      verified.state.augmentation.candidates.some((candidate) => candidate.status === "verified"),
    ).toBe(true);
    await runtime.finalizeAutonomyRuntime({
      workspaceDir,
      state: verified.state,
      cycleStartedAt: verified.cycleStartedAt,
      status: "ok",
      events: verified.events,
      droppedDuplicates: verified.droppedDuplicates,
      droppedInvalid: verified.droppedInvalid,
      droppedOverflow: verified.droppedOverflow,
      remainingEvents: verified.remainingEvents,
      lockToken: verified.lockToken,
    });
  });

  it("ingests plugin-provided autonomy signals", async () => {
    const hooksGlobal = await import("../plugins/hook-runner-global.js");
    hooksGlobal.initializeGlobalHookRunner({
      plugins: [],
      tools: [],
      hooks: [],
      typedHooks: [
        {
          pluginId: "autonomy-test-plugin",
          hookName: "autonomy_signal",
          priority: 10,
          source: "test",
          handler: () => ({
            events: [
              {
                source: "manual",
                type: "plugin.autonomy.signal",
                dedupeKey: "plugin:autonomy:signal",
              },
            ],
          }),
        },
      ],
      channels: [],
      providers: [],
      gatewayHandlers: {},
      httpHandlers: [],
      httpRoutes: [],
      cliRegistrars: [],
      services: [],
      commands: [],
      diagnostics: [],
    });

    const runtime = await import("./runtime.js");
    const prepared = await runtime.prepareAutonomyRuntime({
      agentId: "ops",
      workspaceDir,
      autonomy: { enabled: true },
    });
    if ("skipped" in prepared) {
      throw new Error("expected run to execute");
    }
    expect(prepared.events.some((event) => event.type === "plugin.autonomy.signal")).toBe(true);

    await runtime.finalizeAutonomyRuntime({
      workspaceDir,
      state: prepared.state,
      cycleStartedAt: prepared.cycleStartedAt,
      status: "ok",
      events: prepared.events,
      droppedDuplicates: prepared.droppedDuplicates,
      droppedInvalid: prepared.droppedInvalid,
      droppedOverflow: prepared.droppedOverflow,
      remainingEvents: prepared.remainingEvents,
      lockToken: prepared.lockToken,
    });
  });

  it("blocks promote stage when promotion gates fail", async () => {
    const store = await import("./store.js");
    const runtime = await import("./runtime.js");
    const state = await store.loadAutonomyState({ agentId: "ops" });
    state.augmentation.stage = "promote";
    state.augmentation.candidates = [];
    state.recentCycles = [
      {
        ts: Date.now() - 10_000,
        status: "ok",
        processedEvents: 1,
        durationMs: 100,
      },
      {
        ts: Date.now() - 9_000,
        status: "ok",
        processedEvents: 1,
        durationMs: 100,
      },
      {
        ts: Date.now() - 8_000,
        status: "ok",
        processedEvents: 1,
        durationMs: 100,
      },
    ];
    await store.saveAutonomyState(state);

    const prepared = await runtime.prepareAutonomyRuntime({
      agentId: "ops",
      workspaceDir,
      autonomy: { enabled: true },
    });
    if ("skipped" in prepared) {
      throw new Error("expected run to execute");
    }
    expect(prepared.state.augmentation.stage).toBe("promote");
    const deniedEvent = prepared.events.find(
      (event) => event.type === "autonomy.augmentation.policy.denied",
    );
    expect(deniedEvent).toBeDefined();
    const deniedReason =
      typeof deniedEvent?.payload?.reason === "string" ? deniedEvent.payload.reason : "";
    expect(deniedReason).toContain("no verified candidates");

    await runtime.finalizeAutonomyRuntime({
      workspaceDir,
      state: prepared.state,
      cycleStartedAt: prepared.cycleStartedAt,
      status: "ok",
      events: prepared.events,
      droppedDuplicates: prepared.droppedDuplicates,
      droppedInvalid: prepared.droppedInvalid,
      droppedOverflow: prepared.droppedOverflow,
      remainingEvents: prepared.remainingEvents,
      lockToken: prepared.lockToken,
    });
  });

  it("consumes operator approval event to allow destructive stage transition", async () => {
    const store = await import("./store.js");
    const runtime = await import("./runtime.js");
    const state = await store.loadAutonomyState({ agentId: "ops" });
    state.augmentation.stage = "canary";
    state.augmentation.candidates = [
      {
        id: "candidate-approve",
        sourceGapId: "gap-approve",
        name: "autonomy-approve-skill",
        intent: "allow promote transition",
        status: "verified",
        priority: 100,
        createdAt: Date.now() - 1000,
        updatedAt: Date.now() - 1000,
        safety: {
          executionClass: "reversible_write",
          constraints: ["must be reversible and observable"],
        },
        tests: ["unit: verifies approval bridge"],
      },
    ];
    state.recentCycles = [
      {
        ts: Date.now() - 5_000,
        status: "ok",
        processedEvents: 1,
        durationMs: 100,
      },
      {
        ts: Date.now() - 4_000,
        status: "ok",
        processedEvents: 1,
        durationMs: 110,
      },
      {
        ts: Date.now() - 3_000,
        status: "ok",
        processedEvents: 1,
        durationMs: 120,
      },
    ];
    await store.saveAutonomyState(state);
    await store.enqueueAutonomyEvent({
      agentId: "ops",
      source: "manual",
      type: "autonomy.approval.grant",
      payload: {
        action: "autonomy.stage.promote",
        ttlMinutes: 30,
      },
    });

    const prepared = await runtime.prepareAutonomyRuntime({
      agentId: "ops",
      workspaceDir,
      autonomy: { enabled: true },
    });
    if ("skipped" in prepared) {
      throw new Error("expected run to execute");
    }
    expect(prepared.state.augmentation.stage).toBe("promote");
    expect(prepared.state.approvals["autonomy.stage.promote"]).toBeUndefined();
    expect(prepared.events.some((event) => event.type === "autonomy.approval.applied")).toBe(true);

    await runtime.finalizeAutonomyRuntime({
      workspaceDir,
      state: prepared.state,
      cycleStartedAt: prepared.cycleStartedAt,
      status: "ok",
      events: prepared.events,
      droppedDuplicates: prepared.droppedDuplicates,
      droppedInvalid: prepared.droppedInvalid,
      droppedOverflow: prepared.droppedOverflow,
      remainingEvents: prepared.remainingEvents,
      lockToken: prepared.lockToken,
    });
  });

  it("records long-horizon eval score during promote checks", async () => {
    const store = await import("./store.js");
    const runtime = await import("./runtime.js");
    const state = await store.loadAutonomyState({ agentId: "ops" });
    state.augmentation.stage = "promote";
    state.augmentation.candidates = [
      {
        id: "candidate-promote",
        sourceGapId: "gap-promote",
        name: "autonomy-promote-skill",
        intent: "pass promote stage",
        status: "verified",
        priority: 100,
        createdAt: Date.now() - 1000,
        updatedAt: Date.now() - 1000,
        safety: {
          executionClass: "reversible_write",
          constraints: ["must be reversible and observable"],
        },
        tests: ["unit: promote eval"],
      },
    ];
    state.recentCycles = [
      {
        ts: Date.now() - 8_000,
        status: "ok",
        processedEvents: 1,
        durationMs: 100,
      },
      {
        ts: Date.now() - 7_000,
        status: "ok",
        processedEvents: 1,
        durationMs: 105,
      },
      {
        ts: Date.now() - 6_000,
        status: "ok",
        processedEvents: 1,
        durationMs: 110,
      },
    ];
    await store.saveAutonomyState(state);

    const prepared = await runtime.prepareAutonomyRuntime({
      agentId: "ops",
      workspaceDir,
      autonomy: { enabled: true },
    });
    if ("skipped" in prepared) {
      throw new Error("expected run to execute");
    }
    expect(typeof prepared.state.augmentation.lastEvalScore).toBe("number");
    expect(prepared.state.augmentation.lastEvalScore).toBeGreaterThan(0);
    expect(prepared.state.augmentation.lastEvalAt).toBeDefined();

    await runtime.finalizeAutonomyRuntime({
      workspaceDir,
      state: prepared.state,
      cycleStartedAt: prepared.cycleStartedAt,
      status: "ok",
      events: prepared.events,
      droppedDuplicates: prepared.droppedDuplicates,
      droppedInvalid: prepared.droppedInvalid,
      droppedOverflow: prepared.droppedOverflow,
      remainingEvents: prepared.remainingEvents,
      lockToken: prepared.lockToken,
    });
  });
});
