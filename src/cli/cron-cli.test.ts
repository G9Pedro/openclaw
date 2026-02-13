import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";

const callGatewayFromCli = vi.fn(async (method: string, _opts: unknown, params?: unknown) => {
  if (method === "cron.status") {
    return { enabled: true };
  }
  return { ok: true, params };
});
const enqueueAutonomyEvent = vi.fn(async (_params: unknown) => ({
  id: "evt-1",
  source: "manual",
  type: "manual.event",
}));
const readAutonomyLedgerEntries = vi.fn(async () => [
  {
    id: "ledger-1",
    agentId: "ops",
    ts: 1_700_000_000_000,
    correlationId: "cycle-1",
    eventType: "phase_enter",
    stage: "discover",
    actor: "phase-machine",
    summary: "entered discover",
  },
]);
const loadAutonomyState = vi.fn(async () => ({
  agentId: "ops",
  paused: false,
  pauseReason: undefined,
  pausedAt: undefined,
  mission: "test mission",
  goalsFile: "AUTONOMY_GOALS.md",
  tasksFile: "AUTONOMY_TASKS.md",
  logFile: "AUTONOMY_LOG.md",
  maxActionsPerRun: 3,
  dedupeWindowMs: 3_600_000,
  maxQueuedEvents: 100,
  review: {
    lastDailyReviewDayKey: "2026-02-12",
    lastWeeklyReviewKey: "2026-W06",
  },
  augmentation: {
    stage: "discover",
    stageEnteredAt: 1_700_000_000_000,
    lastTransitionAt: 1_700_000_000_000,
    lastTransitionReason: "boot",
    phaseRunCount: 4,
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
  budget: {
    dayKey: "2026-02-13",
    cyclesUsed: 2,
    tokensUsed: 1200,
  },
  safety: {
    dailyCycleBudget: 30,
    dailyTokenBudget: 100_000,
    maxConsecutiveErrors: 5,
    autoPauseOnBudgetExhausted: true,
    autoResumeOnNewDayBudgetPause: true,
    errorPauseMinutes: 240,
    staleTaskHours: 24,
    emitDailyReviewEvents: true,
    emitWeeklyReviewEvents: true,
  },
  metrics: {
    cycles: 2,
    ok: 2,
    error: 0,
    skipped: 0,
    consecutiveErrors: 0,
  },
}));
const resetAutonomyRuntime = vi.fn(async (_agentId: string) => undefined);

vi.mock("./gateway-rpc.js", async () => {
  const actual = await vi.importActual<typeof import("./gateway-rpc.js")>("./gateway-rpc.js");
  return {
    ...actual,
    callGatewayFromCli: (method: string, opts: unknown, params?: unknown, extra?: unknown) =>
      callGatewayFromCli(method, opts, params, extra),
  };
});

vi.mock("../runtime.js", () => ({
  defaultRuntime: {
    log: vi.fn(),
    error: vi.fn(),
    exit: (code: number) => {
      throw new Error(`__exit__:${code}`);
    },
  },
}));

vi.mock("../autonomy/store.js", () => ({
  enqueueAutonomyEvent: (params: unknown) => enqueueAutonomyEvent(params),
  loadAutonomyState: (params: unknown) => loadAutonomyState(params),
  resetAutonomyRuntime: (agentId: string) => resetAutonomyRuntime(agentId),
}));

vi.mock("../autonomy/ledger/store.js", () => ({
  readAutonomyLedgerEntries: (params: unknown) => readAutonomyLedgerEntries(params),
}));

describe("cron cli", () => {
  it("trims model and thinking on cron add", { timeout: 60_000 }, async () => {
    callGatewayFromCli.mockClear();

    const { registerCronCli } = await import("./cron-cli.js");
    const program = new Command();
    program.exitOverride();
    registerCronCli(program);

    await program.parseAsync(
      [
        "cron",
        "add",
        "--name",
        "Daily",
        "--cron",
        "* * * * *",
        "--session",
        "isolated",
        "--message",
        "hello",
        "--model",
        "  opus  ",
        "--thinking",
        "  low  ",
      ],
      { from: "user" },
    );

    const addCall = callGatewayFromCli.mock.calls.find((call) => call[0] === "cron.add");
    const params = addCall?.[2] as {
      payload?: { model?: string; thinking?: string };
    };

    expect(params?.payload?.model).toBe("opus");
    expect(params?.payload?.thinking).toBe("low");
  });

  it("sends agent id on cron add", async () => {
    callGatewayFromCli.mockClear();

    const { registerCronCli } = await import("./cron-cli.js");
    const program = new Command();
    program.exitOverride();
    registerCronCli(program);

    await program.parseAsync(
      [
        "cron",
        "add",
        "--name",
        "Agent pinned",
        "--cron",
        "* * * * *",
        "--session",
        "isolated",
        "--message",
        "hi",
        "--agent",
        "ops",
      ],
      { from: "user" },
    );

    const addCall = callGatewayFromCli.mock.calls.find((call) => call[0] === "cron.add");
    const params = addCall?.[2] as { agentId?: string };
    expect(params?.agentId).toBe("ops");
  });

  it("omits empty model and thinking on cron edit", async () => {
    callGatewayFromCli.mockClear();

    const { registerCronCli } = await import("./cron-cli.js");
    const program = new Command();
    program.exitOverride();
    registerCronCli(program);

    await program.parseAsync(
      ["cron", "edit", "job-1", "--message", "hello", "--model", "   ", "--thinking", "  "],
      { from: "user" },
    );

    const updateCall = callGatewayFromCli.mock.calls.find((call) => call[0] === "cron.update");
    const patch = updateCall?.[2] as {
      patch?: { payload?: { model?: string; thinking?: string } };
    };

    expect(patch?.patch?.payload?.model).toBeUndefined();
    expect(patch?.patch?.payload?.thinking).toBeUndefined();
  });

  it("trims model and thinking on cron edit", async () => {
    callGatewayFromCli.mockClear();

    const { registerCronCli } = await import("./cron-cli.js");
    const program = new Command();
    program.exitOverride();
    registerCronCli(program);

    await program.parseAsync(
      [
        "cron",
        "edit",
        "job-1",
        "--message",
        "hello",
        "--model",
        "  opus  ",
        "--thinking",
        "  high  ",
      ],
      { from: "user" },
    );

    const updateCall = callGatewayFromCli.mock.calls.find((call) => call[0] === "cron.update");
    const patch = updateCall?.[2] as {
      patch?: { payload?: { model?: string; thinking?: string } };
    };

    expect(patch?.patch?.payload?.model).toBe("opus");
    expect(patch?.patch?.payload?.thinking).toBe("high");
  });

  it("sets and clears agent id on cron edit", async () => {
    callGatewayFromCli.mockClear();

    const { registerCronCli } = await import("./cron-cli.js");
    const program = new Command();
    program.exitOverride();
    registerCronCli(program);

    await program.parseAsync(["cron", "edit", "job-1", "--agent", " Ops ", "--message", "hello"], {
      from: "user",
    });

    const updateCall = callGatewayFromCli.mock.calls.find((call) => call[0] === "cron.update");
    const patch = updateCall?.[2] as { patch?: { agentId?: unknown } };
    expect(patch?.patch?.agentId).toBe("ops");

    callGatewayFromCli.mockClear();
    await program.parseAsync(["cron", "edit", "job-2", "--clear-agent"], {
      from: "user",
    });
    const clearCall = callGatewayFromCli.mock.calls.find((call) => call[0] === "cron.update");
    const clearPatch = clearCall?.[2] as { patch?: { agentId?: unknown } };
    expect(clearPatch?.patch?.agentId).toBeNull();
  });

  it("allows model/thinking updates without --message", async () => {
    callGatewayFromCli.mockClear();

    const { registerCronCli } = await import("./cron-cli.js");
    const program = new Command();
    program.exitOverride();
    registerCronCli(program);

    await program.parseAsync(["cron", "edit", "job-1", "--model", "opus", "--thinking", "low"], {
      from: "user",
    });

    const updateCall = callGatewayFromCli.mock.calls.find((call) => call[0] === "cron.update");
    const patch = updateCall?.[2] as {
      patch?: { payload?: { kind?: string; model?: string; thinking?: string } };
    };

    expect(patch?.patch?.payload?.kind).toBe("agentTurn");
    expect(patch?.patch?.payload?.model).toBe("opus");
    expect(patch?.patch?.payload?.thinking).toBe("low");
  });

  it("updates delivery settings without requiring --message", async () => {
    callGatewayFromCli.mockClear();

    const { registerCronCli } = await import("./cron-cli.js");
    const program = new Command();
    program.exitOverride();
    registerCronCli(program);

    await program.parseAsync(
      ["cron", "edit", "job-1", "--deliver", "--channel", "telegram", "--to", "19098680"],
      { from: "user" },
    );

    const updateCall = callGatewayFromCli.mock.calls.find((call) => call[0] === "cron.update");
    const patch = updateCall?.[2] as {
      patch?: {
        payload?: {
          kind?: string;
          message?: string;
          deliver?: boolean;
          channel?: string;
          to?: string;
        };
      };
    };

    expect(patch?.patch?.payload?.kind).toBe("agentTurn");
    expect(patch?.patch?.payload?.deliver).toBe(true);
    expect(patch?.patch?.payload?.channel).toBe("telegram");
    expect(patch?.patch?.payload?.to).toBe("19098680");
    expect(patch?.patch?.payload?.message).toBeUndefined();
  });

  it("supports --no-deliver on cron edit", async () => {
    callGatewayFromCli.mockClear();

    const { registerCronCli } = await import("./cron-cli.js");
    const program = new Command();
    program.exitOverride();
    registerCronCli(program);

    await program.parseAsync(["cron", "edit", "job-1", "--no-deliver"], { from: "user" });

    const updateCall = callGatewayFromCli.mock.calls.find((call) => call[0] === "cron.update");
    const patch = updateCall?.[2] as {
      patch?: { payload?: { kind?: string; deliver?: boolean } };
    };

    expect(patch?.patch?.payload?.kind).toBe("agentTurn");
    expect(patch?.patch?.payload?.deliver).toBe(false);
  });

  it("does not include undefined delivery fields when updating message", async () => {
    callGatewayFromCli.mockClear();

    const { registerCronCli } = await import("./cron-cli.js");
    const program = new Command();
    program.exitOverride();
    registerCronCli(program);

    // Update message without delivery flags - should NOT include undefined delivery fields
    await program.parseAsync(["cron", "edit", "job-1", "--message", "Updated message"], {
      from: "user",
    });

    const updateCall = callGatewayFromCli.mock.calls.find((call) => call[0] === "cron.update");
    const patch = updateCall?.[2] as {
      patch?: {
        payload?: {
          message?: string;
          deliver?: boolean;
          channel?: string;
          to?: string;
          bestEffortDeliver?: boolean;
        };
      };
    };

    // Should include the new message
    expect(patch?.patch?.payload?.message).toBe("Updated message");

    // Should NOT include delivery fields at all (to preserve existing values)
    expect(patch?.patch?.payload).not.toHaveProperty("deliver");
    expect(patch?.patch?.payload).not.toHaveProperty("channel");
    expect(patch?.patch?.payload).not.toHaveProperty("to");
    expect(patch?.patch?.payload).not.toHaveProperty("bestEffortDeliver");
  });

  it("includes delivery fields when explicitly provided with message", async () => {
    callGatewayFromCli.mockClear();

    const { registerCronCli } = await import("./cron-cli.js");
    const program = new Command();
    program.exitOverride();
    registerCronCli(program);

    // Update message AND delivery - should include both
    await program.parseAsync(
      [
        "cron",
        "edit",
        "job-1",
        "--message",
        "Updated message",
        "--deliver",
        "--channel",
        "telegram",
        "--to",
        "19098680",
      ],
      { from: "user" },
    );

    const updateCall = callGatewayFromCli.mock.calls.find((call) => call[0] === "cron.update");
    const patch = updateCall?.[2] as {
      patch?: {
        payload?: {
          message?: string;
          deliver?: boolean;
          channel?: string;
          to?: string;
        };
      };
    };

    // Should include everything
    expect(patch?.patch?.payload?.message).toBe("Updated message");
    expect(patch?.patch?.payload?.deliver).toBe(true);
    expect(patch?.patch?.payload?.channel).toBe("telegram");
    expect(patch?.patch?.payload?.to).toBe("19098680");
  });

  it("includes best-effort delivery when provided with message", async () => {
    callGatewayFromCli.mockClear();

    const { registerCronCli } = await import("./cron-cli.js");
    const program = new Command();
    program.exitOverride();
    registerCronCli(program);

    await program.parseAsync(
      ["cron", "edit", "job-1", "--message", "Updated message", "--best-effort-deliver"],
      { from: "user" },
    );

    const updateCall = callGatewayFromCli.mock.calls.find((call) => call[0] === "cron.update");
    const patch = updateCall?.[2] as {
      patch?: { payload?: { message?: string; bestEffortDeliver?: boolean } };
    };

    expect(patch?.patch?.payload?.message).toBe("Updated message");
    expect(patch?.patch?.payload?.bestEffortDeliver).toBe(true);
  });

  it("includes no-best-effort delivery when provided with message", async () => {
    callGatewayFromCli.mockClear();

    const { registerCronCli } = await import("./cron-cli.js");
    const program = new Command();
    program.exitOverride();
    registerCronCli(program);

    await program.parseAsync(
      ["cron", "edit", "job-1", "--message", "Updated message", "--no-best-effort-deliver"],
      { from: "user" },
    );

    const updateCall = callGatewayFromCli.mock.calls.find((call) => call[0] === "cron.update");
    const patch = updateCall?.[2] as {
      patch?: { payload?: { message?: string; bestEffortDeliver?: boolean } };
    };

    expect(patch?.patch?.payload?.message).toBe("Updated message");
    expect(patch?.patch?.payload?.bestEffortDeliver).toBe(false);
  });

  it("creates autonomous cron job with runtime autonomy config", async () => {
    callGatewayFromCli.mockClear();

    const { registerCronCli } = await import("./cron-cli.js");
    const program = new Command();
    program.exitOverride();
    registerCronCli(program);

    await program.parseAsync(
      ["cron", "autonomous", "--mission", "Ship high-impact outcomes continuously"],
      { from: "user" },
    );

    const addCall = callGatewayFromCli.mock.calls.find((call) => call[0] === "cron.add");
    const params = addCall?.[2] as {
      sessionTarget?: string;
      schedule?: { kind?: string; everyMs?: number };
      payload?: {
        kind?: string;
        message?: string;
        autonomy?: {
          enabled?: boolean;
          paused?: boolean;
          mission?: string;
          maxActionsPerRun?: number;
          maxConsecutiveErrors?: number;
          autoPauseOnBudgetExhausted?: boolean;
          autoResumeOnNewDayBudgetPause?: boolean;
          errorPauseMinutes?: number;
          staleTaskHours?: number;
          emitDailyReviewEvents?: boolean;
          emitWeeklyReviewEvents?: boolean;
        };
      };
      isolation?: { postToMainPrefix?: string };
    };

    expect(params?.sessionTarget).toBe("isolated");
    expect(params?.schedule?.kind).toBe("every");
    expect(params?.schedule?.everyMs).toBe(600_000);
    expect(params?.payload?.kind).toBe("agentTurn");
    expect(params?.payload?.message).toContain("Run autonomous coordination cycle");
    expect(params?.payload?.autonomy?.enabled).toBe(true);
    expect(params?.payload?.autonomy?.paused).toBe(false);
    expect(params?.payload?.autonomy?.mission).toContain("Ship high-impact outcomes continuously");
    expect(params?.payload?.autonomy?.maxActionsPerRun).toBe(3);
    expect(params?.payload?.autonomy?.maxConsecutiveErrors).toBe(5);
    expect(params?.payload?.autonomy?.autoPauseOnBudgetExhausted).toBe(true);
    expect(params?.payload?.autonomy?.autoResumeOnNewDayBudgetPause).toBe(true);
    expect(params?.payload?.autonomy?.errorPauseMinutes).toBe(240);
    expect(params?.payload?.autonomy?.staleTaskHours).toBe(24);
    expect(params?.payload?.autonomy?.emitDailyReviewEvents).toBe(true);
    expect(params?.payload?.autonomy?.emitWeeklyReviewEvents).toBe(true);
    expect(params?.isolation?.postToMainPrefix).toBe("Autonomy");
  });

  it("supports autonomous command overrides for delivery and persistence paths", async () => {
    callGatewayFromCli.mockClear();

    const { registerCronCli } = await import("./cron-cli.js");
    const program = new Command();
    program.exitOverride();
    registerCronCli(program);

    await program.parseAsync(
      [
        "cron",
        "autonomous",
        "--every",
        "5m",
        "--agent",
        " Ops ",
        "--model",
        " opus ",
        "--thinking",
        " low ",
        "--timeout-seconds",
        "90",
        "--max-actions",
        "7",
        "--daily-token-budget",
        "120000",
        "--daily-cycle-budget",
        "50",
        "--max-consecutive-errors",
        "9",
        "--no-auto-pause-on-budget",
        "--no-auto-resume-on-new-day-budget",
        "--error-pause-minutes",
        "30",
        "--stale-task-hours",
        "48",
        "--no-emit-daily-review-events",
        "--no-emit-weekly-review-events",
        "--goals-file",
        "GOALS.md",
        "--tasks-file",
        "TASKS.md",
        "--log-file",
        "LOG.md",
        "--deliver",
        "--channel",
        "telegram",
        "--to",
        "19098680",
        "--best-effort-deliver",
      ],
      { from: "user" },
    );

    const addCall = callGatewayFromCli.mock.calls.find((call) => call[0] === "cron.add");
    const params = addCall?.[2] as {
      agentId?: string;
      schedule?: { kind?: string; everyMs?: number };
      payload?: {
        model?: string;
        thinking?: string;
        timeoutSeconds?: number;
        deliver?: boolean;
        channel?: string;
        to?: string;
        bestEffortDeliver?: boolean;
        message?: string;
        autonomy?: {
          goalsFile?: string;
          tasksFile?: string;
          logFile?: string;
          maxActionsPerRun?: number;
          dedupeWindowMinutes?: number;
          maxQueuedEvents?: number;
          dailyTokenBudget?: number;
          dailyCycleBudget?: number;
          maxConsecutiveErrors?: number;
          autoPauseOnBudgetExhausted?: boolean;
          autoResumeOnNewDayBudgetPause?: boolean;
          errorPauseMinutes?: number;
          staleTaskHours?: number;
          emitDailyReviewEvents?: boolean;
          emitWeeklyReviewEvents?: boolean;
        };
      };
    };

    expect(params?.agentId).toBe("ops");
    expect(params?.schedule?.kind).toBe("every");
    expect(params?.schedule?.everyMs).toBe(300_000);
    expect(params?.payload?.model).toBe("opus");
    expect(params?.payload?.thinking).toBe("low");
    expect(params?.payload?.timeoutSeconds).toBe(90);
    expect(params?.payload?.deliver).toBe(true);
    expect(params?.payload?.channel).toBe("telegram");
    expect(params?.payload?.to).toBe("19098680");
    expect(params?.payload?.bestEffortDeliver).toBe(true);
    expect(params?.payload?.autonomy?.goalsFile).toBe("GOALS.md");
    expect(params?.payload?.autonomy?.tasksFile).toBe("TASKS.md");
    expect(params?.payload?.autonomy?.logFile).toBe("LOG.md");
    expect(params?.payload?.autonomy?.maxActionsPerRun).toBe(7);
    expect(params?.payload?.autonomy?.dedupeWindowMinutes).toBe(60);
    expect(params?.payload?.autonomy?.maxQueuedEvents).toBe(100);
    expect(params?.payload?.autonomy?.dailyTokenBudget).toBe(120000);
    expect(params?.payload?.autonomy?.dailyCycleBudget).toBe(50);
    expect(params?.payload?.autonomy?.maxConsecutiveErrors).toBe(9);
    expect(params?.payload?.autonomy?.autoPauseOnBudgetExhausted).toBe(false);
    expect(params?.payload?.autonomy?.autoResumeOnNewDayBudgetPause).toBe(false);
    expect(params?.payload?.autonomy?.errorPauseMinutes).toBe(30);
    expect(params?.payload?.autonomy?.staleTaskHours).toBe(48);
    expect(params?.payload?.autonomy?.emitDailyReviewEvents).toBe(false);
    expect(params?.payload?.autonomy?.emitWeeklyReviewEvents).toBe(false);
  });

  it("pauses and resumes autonomous jobs via cron.update", async () => {
    callGatewayFromCli.mockClear();

    const { registerCronCli } = await import("./cron-cli.js");
    const program = new Command();
    program.exitOverride();
    registerCronCli(program);

    await program.parseAsync(["cron", "autonomous-pause", "job-1"], { from: "user" });
    const pauseCall = callGatewayFromCli.mock.calls.find((call) => call[0] === "cron.update");
    const pausePatch = pauseCall?.[2] as {
      patch?: { payload?: { kind?: string; autonomy?: { enabled?: boolean; paused?: boolean } } };
    };
    expect(pausePatch?.patch?.payload?.kind).toBe("agentTurn");
    expect(pausePatch?.patch?.payload?.autonomy?.enabled).toBe(true);
    expect(pausePatch?.patch?.payload?.autonomy?.paused).toBe(true);

    callGatewayFromCli.mockClear();
    await program.parseAsync(["cron", "autonomous-resume", "job-1"], { from: "user" });
    const resumeCall = callGatewayFromCli.mock.calls.find((call) => call[0] === "cron.update");
    const resumePatch = resumeCall?.[2] as {
      patch?: { payload?: { kind?: string; autonomy?: { enabled?: boolean; paused?: boolean } } };
    };
    expect(resumePatch?.patch?.payload?.kind).toBe("agentTurn");
    expect(resumePatch?.patch?.payload?.autonomy?.enabled).toBe(true);
    expect(resumePatch?.patch?.payload?.autonomy?.paused).toBe(false);
  });

  it("lists autonomous jobs via autonomous-status", async () => {
    callGatewayFromCli.mockClear();
    callGatewayFromCli.mockImplementationOnce(async () => ({
      jobs: [
        {
          id: "job-1",
          name: "autonomy",
          enabled: true,
          agentId: "ops",
          state: { nextRunAtMs: 1_700_000_000_000 },
          payload: {
            kind: "agentTurn",
            autonomy: { enabled: true, paused: false },
          },
        },
      ],
    }));

    const { registerCronCli } = await import("./cron-cli.js");
    const program = new Command();
    program.exitOverride();
    registerCronCli(program);

    await program.parseAsync(["cron", "autonomous-status", "--json"], { from: "user" });
    const listCall = callGatewayFromCli.mock.calls.find((call) => call[0] === "cron.list");
    expect(listCall?.[2]).toEqual({ includeDisabled: true });
  });

  it("inspects and resets autonomy runtime state", async () => {
    callGatewayFromCli.mockClear();
    loadAutonomyState.mockClear();
    resetAutonomyRuntime.mockClear();

    const { registerCronCli } = await import("./cron-cli.js");
    const program = new Command();
    program.exitOverride();
    registerCronCli(program);

    await program.parseAsync(["cron", "autonomous-inspect", "--agent", " Ops ", "--json"], {
      from: "user",
    });
    expect(loadAutonomyState).toHaveBeenCalledWith({ agentId: "ops" });

    await program.parseAsync(["cron", "autonomous-reset", "--agent", " Ops "], { from: "user" });
    expect(resetAutonomyRuntime).toHaveBeenCalledWith("ops");
  });

  it("summarizes autonomy health", async () => {
    loadAutonomyState.mockClear();

    const { registerCronCli } = await import("./cron-cli.js");
    const program = new Command();
    program.exitOverride();
    registerCronCli(program);

    await program.parseAsync(["cron", "autonomous-health", "--agent", " Ops ", "--json"], {
      from: "user",
    });
    expect(loadAutonomyState).toHaveBeenCalledWith({ agentId: "ops" });
  });

  it("lists augmentation ledger entries", async () => {
    readAutonomyLedgerEntries.mockClear();
    const { registerCronCli } = await import("./cron-cli.js");
    const program = new Command();
    program.exitOverride();
    registerCronCli(program);

    await program.parseAsync(
      ["cron", "autonomous-ledger", "--agent", " Ops ", "--limit", "10", "--offset", "0", "--json"],
      {
        from: "user",
      },
    );
    expect(readAutonomyLedgerEntries).toHaveBeenCalledWith({
      agentId: "ops",
      limit: 10,
      offset: 0,
    });
  });

  it("tunes autonomy fields on an existing job", async () => {
    callGatewayFromCli.mockClear();

    const { registerCronCli } = await import("./cron-cli.js");
    const program = new Command();
    program.exitOverride();
    registerCronCli(program);

    await program.parseAsync(
      [
        "cron",
        "autonomous-tune",
        "job-1",
        "--mission",
        "new mission",
        "--max-actions",
        "6",
        "--daily-token-budget",
        "200000",
        "--error-pause-minutes",
        "45",
        "--stale-task-hours",
        "36",
        "--no-auto-resume-on-new-day-budget",
        "--no-emit-daily-review-events",
        "--pause",
      ],
      { from: "user" },
    );
    const updateCall = callGatewayFromCli.mock.calls.find((call) => call[0] === "cron.update");
    const patch = updateCall?.[2] as {
      patch?: {
        payload?: {
          kind?: string;
          autonomy?: {
            mission?: string;
            maxActionsPerRun?: number;
            dailyTokenBudget?: number;
            errorPauseMinutes?: number;
            staleTaskHours?: number;
            autoResumeOnNewDayBudgetPause?: boolean;
            emitDailyReviewEvents?: boolean;
            paused?: boolean;
          };
        };
      };
    };
    expect(patch?.patch?.payload?.kind).toBe("agentTurn");
    expect(patch?.patch?.payload?.autonomy?.mission).toBe("new mission");
    expect(patch?.patch?.payload?.autonomy?.maxActionsPerRun).toBe(6);
    expect(patch?.patch?.payload?.autonomy?.dailyTokenBudget).toBe(200000);
    expect(patch?.patch?.payload?.autonomy?.errorPauseMinutes).toBe(45);
    expect(patch?.patch?.payload?.autonomy?.staleTaskHours).toBe(36);
    expect(patch?.patch?.payload?.autonomy?.autoResumeOnNewDayBudgetPause).toBe(false);
    expect(patch?.patch?.payload?.autonomy?.emitDailyReviewEvents).toBe(false);
    expect(patch?.patch?.payload?.autonomy?.paused).toBe(true);
  });

  it("injects autonomy events from cli", async () => {
    callGatewayFromCli.mockClear();
    enqueueAutonomyEvent.mockClear();

    const { registerCronCli } = await import("./cron-cli.js");
    const program = new Command();
    program.exitOverride();
    registerCronCli(program);

    await program.parseAsync(
      [
        "cron",
        "autonomous-event",
        "--agent",
        "ops",
        "--source",
        "webhook",
        "--type",
        "hook.received",
        "--dedupe-key",
        "evt-123",
        "--payload",
        '{"k":"v"}',
      ],
      { from: "user" },
    );
    expect(enqueueAutonomyEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "ops",
        source: "webhook",
        type: "hook.received",
        dedupeKey: "evt-123",
      }),
    );
  });
});
