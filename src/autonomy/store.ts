import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type {
  AutonomyCycleRecord,
  AutonomyEvent,
  AutonomyEventSource,
  AutonomyState,
} from "./types.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { CONFIG_DIR } from "../utils.js";

const AUTONOMY_DIR = path.join(CONFIG_DIR, "autonomy");
const STATE_FILENAME = "state.json";
const EVENTS_FILENAME = "events.jsonl";
const MAX_RECENT_EVENTS = 50;
const MAX_RECENT_CYCLES = 50;
const DEFAULT_DEDUPE_WINDOW_MS = 60 * 60_000;
const DEFAULT_MAX_QUEUED_EVENTS = 100;
const DEFAULT_MAX_CONSECUTIVE_ERRORS = 5;
const DEFAULT_ERROR_PAUSE_MINUTES = 240;
const DEFAULT_STALE_TASK_HOURS = 24;

const writesByPath = new Map<string, Promise<void>>();

type PartialAutonomyState = {
  mission?: AutonomyState["mission"];
  paused?: AutonomyState["paused"];
  pauseReason?: AutonomyState["pauseReason"];
  pausedAt?: AutonomyState["pausedAt"];
  goalsFile?: AutonomyState["goalsFile"];
  tasksFile?: AutonomyState["tasksFile"];
  logFile?: AutonomyState["logFile"];
  maxActionsPerRun?: AutonomyState["maxActionsPerRun"];
  dedupeWindowMs?: AutonomyState["dedupeWindowMs"];
  maxQueuedEvents?: AutonomyState["maxQueuedEvents"];
  safety?: Partial<AutonomyState["safety"]>;
  budget?: Partial<AutonomyState["budget"]>;
  review?: Partial<AutonomyState["review"]>;
  taskSignals?: AutonomyState["taskSignals"];
};

function normalizeOptionalString(value: unknown) {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function clampInt(value: number | undefined, min: number, max: number, fallback: number) {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.floor(value as number)));
}

function resolveDayKey(nowMs: number) {
  return new Date(nowMs).toISOString().slice(0, 10);
}

export function resolveIsoWeekKey(nowMs: number) {
  const date = new Date(nowMs);
  const utc = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = utc.getUTCDay() || 7;
  utc.setUTCDate(utc.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((utc.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${utc.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function resolveEventDedupeKey(event: AutonomyEvent) {
  if (event.dedupeKey?.trim()) {
    return event.dedupeKey.trim();
  }
  if (event.id.trim()) {
    return event.id.trim();
  }
  return `${event.source}:${event.type}`;
}

function pruneDedupeMap(state: AutonomyState, nowMs: number) {
  const minTs = nowMs - Math.max(state.dedupeWindowMs * 3, state.dedupeWindowMs);
  for (const [key, ts] of Object.entries(state.dedupe)) {
    if (!Number.isFinite(ts) || ts < minTs) {
      delete state.dedupe[key];
    }
  }
}

function withSerializedWrite(filePath: string, run: () => Promise<void>) {
  const resolved = path.resolve(filePath);
  const prev = writesByPath.get(resolved) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(run);
  writesByPath.set(resolved, next);
  return next;
}

function buildDefaultState(agentId: string, defaults?: PartialAutonomyState): AutonomyState {
  const normalizedAgentId = normalizeAgentId(agentId);
  const dedupeWindowMs = clampInt(
    defaults?.dedupeWindowMs,
    60_000,
    24 * 60 * 60_000,
    DEFAULT_DEDUPE_WINDOW_MS,
  );
  const nowMs = Date.now();
  const dayKey = resolveDayKey(nowMs);
  return {
    version: 1,
    agentId: normalizedAgentId,
    mission:
      normalizeOptionalString(defaults?.mission) ??
      "Continuously pursue useful long-term goals using external signals and delegated work.",
    paused: defaults?.paused === true,
    pauseReason: defaults?.pauseReason,
    pausedAt: defaults?.pausedAt,
    goalsFile: normalizeOptionalString(defaults?.goalsFile) ?? "AUTONOMY_GOALS.md",
    tasksFile: normalizeOptionalString(defaults?.tasksFile) ?? "AUTONOMY_TASKS.md",
    logFile: normalizeOptionalString(defaults?.logFile) ?? "AUTONOMY_LOG.md",
    maxActionsPerRun: clampInt(defaults?.maxActionsPerRun, 1, 20, 3),
    dedupeWindowMs,
    maxQueuedEvents: clampInt(defaults?.maxQueuedEvents, 1, 500, DEFAULT_MAX_QUEUED_EVENTS),
    safety: {
      dailyTokenBudget:
        defaults?.safety?.dailyTokenBudget && Number.isFinite(defaults.safety.dailyTokenBudget)
          ? Math.max(1, Math.floor(defaults.safety.dailyTokenBudget))
          : undefined,
      dailyCycleBudget:
        defaults?.safety?.dailyCycleBudget && Number.isFinite(defaults.safety.dailyCycleBudget)
          ? Math.max(1, Math.floor(defaults.safety.dailyCycleBudget))
          : undefined,
      maxConsecutiveErrors: clampInt(
        defaults?.safety?.maxConsecutiveErrors,
        1,
        100,
        DEFAULT_MAX_CONSECUTIVE_ERRORS,
      ),
      autoPauseOnBudgetExhausted: defaults?.safety?.autoPauseOnBudgetExhausted !== false,
      autoResumeOnNewDayBudgetPause: defaults?.safety?.autoResumeOnNewDayBudgetPause !== false,
      errorPauseMinutes: clampInt(
        defaults?.safety?.errorPauseMinutes,
        1,
        24 * 60,
        DEFAULT_ERROR_PAUSE_MINUTES,
      ),
      staleTaskHours: clampInt(
        defaults?.safety?.staleTaskHours,
        1,
        24 * 30,
        DEFAULT_STALE_TASK_HOURS,
      ),
      emitDailyReviewEvents: defaults?.safety?.emitDailyReviewEvents !== false,
      emitWeeklyReviewEvents: defaults?.safety?.emitWeeklyReviewEvents !== false,
    },
    budget: {
      dayKey,
      cyclesUsed: 0,
      tokensUsed: 0,
    },
    review: {
      lastDailyReviewDayKey: defaults?.review?.lastDailyReviewDayKey,
      lastWeeklyReviewKey: defaults?.review?.lastWeeklyReviewKey,
    },
    taskSignals: defaults?.taskSignals ? { ...defaults.taskSignals } : {},
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

export function resolveAutonomyAgentDir(agentId: string) {
  return path.join(AUTONOMY_DIR, normalizeAgentId(agentId));
}

export function resolveAutonomyStatePath(agentId: string) {
  return path.join(resolveAutonomyAgentDir(agentId), STATE_FILENAME);
}

export function resolveAutonomyEventsPath(agentId: string) {
  return path.join(resolveAutonomyAgentDir(agentId), EVENTS_FILENAME);
}

export async function hasAutonomyState(agentId: string) {
  const statePath = resolveAutonomyStatePath(agentId);
  try {
    await fs.access(statePath);
    return true;
  } catch {
    return false;
  }
}

export async function resetAutonomyRuntime(agentId: string) {
  const dir = resolveAutonomyAgentDir(agentId);
  await fs.rm(dir, { recursive: true, force: true });
}

export function refreshAutonomyBudgetWindow(state: AutonomyState, nowMs = Date.now()) {
  const dayKey = resolveDayKey(nowMs);
  if (state.budget.dayKey === dayKey) {
    return false;
  }
  state.budget.dayKey = dayKey;
  state.budget.cyclesUsed = 0;
  state.budget.tokensUsed = 0;
  return true;
}

export function applyAutonomyPause(
  state: AutonomyState,
  reason: NonNullable<AutonomyState["pauseReason"]>,
  nowMs = Date.now(),
) {
  state.paused = true;
  state.pauseReason = reason;
  state.pausedAt = nowMs;
}

export function clearAutonomyPause(state: AutonomyState) {
  state.paused = false;
  state.pauseReason = undefined;
  state.pausedAt = undefined;
}

export async function loadAutonomyState(params: {
  agentId: string;
  defaults?: PartialAutonomyState;
}): Promise<AutonomyState> {
  const statePath = resolveAutonomyStatePath(params.agentId);
  const raw = await fs.readFile(statePath, "utf-8").catch(() => "");
  if (!raw.trim()) {
    const state = buildDefaultState(params.agentId, params.defaults);
    await saveAutonomyState(state);
    return state;
  }
  let parsed: Partial<AutonomyState> | null = null;
  try {
    parsed = JSON.parse(raw) as Partial<AutonomyState>;
  } catch {
    parsed = null;
  }
  const state = buildDefaultState(params.agentId, params.defaults);
  if (parsed && typeof parsed === "object") {
    state.mission = normalizeOptionalString(parsed.mission) ?? state.mission;
    state.paused = parsed.paused === true;
    const pauseReasonRaw = (parsed as { pauseReason?: unknown }).pauseReason;
    state.pauseReason =
      pauseReasonRaw === "manual" || pauseReasonRaw === "budget" || pauseReasonRaw === "errors"
        ? pauseReasonRaw
        : undefined;
    state.pausedAt =
      typeof (parsed as { pausedAt?: unknown }).pausedAt === "number" &&
      Number.isFinite((parsed as { pausedAt?: unknown }).pausedAt)
        ? Math.max(0, Math.floor((parsed as { pausedAt?: number }).pausedAt as number))
        : undefined;
    state.goalsFile = normalizeOptionalString(parsed.goalsFile) ?? state.goalsFile;
    state.tasksFile = normalizeOptionalString(parsed.tasksFile) ?? state.tasksFile;
    state.logFile = normalizeOptionalString(parsed.logFile) ?? state.logFile;
    state.maxActionsPerRun = clampInt(parsed.maxActionsPerRun, 1, 20, state.maxActionsPerRun);
    state.dedupeWindowMs = clampInt(
      parsed.dedupeWindowMs,
      60_000,
      24 * 60 * 60_000,
      state.dedupeWindowMs,
    );
    state.maxQueuedEvents = clampInt(parsed.maxQueuedEvents, 1, 500, state.maxQueuedEvents);
    if (parsed.safety && typeof parsed.safety === "object") {
      const dailyTokenBudget = (parsed.safety as { dailyTokenBudget?: unknown }).dailyTokenBudget;
      const dailyCycleBudget = (parsed.safety as { dailyCycleBudget?: unknown }).dailyCycleBudget;
      const maxConsecutiveErrors = (parsed.safety as { maxConsecutiveErrors?: unknown })
        .maxConsecutiveErrors;
      const autoPauseOnBudgetExhausted = (parsed.safety as { autoPauseOnBudgetExhausted?: unknown })
        .autoPauseOnBudgetExhausted;
      const autoResumeOnNewDayBudgetPause = (
        parsed.safety as { autoResumeOnNewDayBudgetPause?: unknown }
      ).autoResumeOnNewDayBudgetPause;
      const errorPauseMinutes = (parsed.safety as { errorPauseMinutes?: unknown })
        .errorPauseMinutes;
      const staleTaskHours = (parsed.safety as { staleTaskHours?: unknown }).staleTaskHours;
      const emitDailyReviewEvents = (parsed.safety as { emitDailyReviewEvents?: unknown })
        .emitDailyReviewEvents;
      const emitWeeklyReviewEvents = (parsed.safety as { emitWeeklyReviewEvents?: unknown })
        .emitWeeklyReviewEvents;
      state.safety.dailyTokenBudget =
        typeof dailyTokenBudget === "number" && Number.isFinite(dailyTokenBudget)
          ? Math.max(1, Math.floor(dailyTokenBudget))
          : undefined;
      state.safety.dailyCycleBudget =
        typeof dailyCycleBudget === "number" && Number.isFinite(dailyCycleBudget)
          ? Math.max(1, Math.floor(dailyCycleBudget))
          : undefined;
      state.safety.maxConsecutiveErrors = clampInt(
        typeof maxConsecutiveErrors === "number" ? maxConsecutiveErrors : undefined,
        1,
        100,
        state.safety.maxConsecutiveErrors,
      );
      state.safety.autoPauseOnBudgetExhausted = autoPauseOnBudgetExhausted !== false;
      state.safety.autoResumeOnNewDayBudgetPause = autoResumeOnNewDayBudgetPause !== false;
      state.safety.errorPauseMinutes = clampInt(
        typeof errorPauseMinutes === "number" ? errorPauseMinutes : undefined,
        1,
        24 * 60,
        state.safety.errorPauseMinutes,
      );
      state.safety.staleTaskHours = clampInt(
        typeof staleTaskHours === "number" ? staleTaskHours : undefined,
        1,
        24 * 30,
        state.safety.staleTaskHours,
      );
      state.safety.emitDailyReviewEvents = emitDailyReviewEvents !== false;
      state.safety.emitWeeklyReviewEvents = emitWeeklyReviewEvents !== false;
    }
    if (parsed.budget && typeof parsed.budget === "object") {
      const dayKey = (parsed.budget as { dayKey?: unknown }).dayKey;
      const cyclesUsed = (parsed.budget as { cyclesUsed?: unknown }).cyclesUsed;
      const tokensUsed = (parsed.budget as { tokensUsed?: unknown }).tokensUsed;
      state.budget.dayKey =
        typeof dayKey === "string" && dayKey.trim() ? dayKey : state.budget.dayKey;
      state.budget.cyclesUsed =
        typeof cyclesUsed === "number" && Number.isFinite(cyclesUsed)
          ? Math.max(0, Math.floor(cyclesUsed))
          : 0;
      state.budget.tokensUsed =
        typeof tokensUsed === "number" && Number.isFinite(tokensUsed)
          ? Math.max(0, Math.floor(tokensUsed))
          : 0;
    }
    state.dedupe = parsed.dedupe && typeof parsed.dedupe === "object" ? { ...parsed.dedupe } : {};
    if (parsed.review && typeof parsed.review === "object") {
      const lastDailyReviewDayKey = (parsed.review as { lastDailyReviewDayKey?: unknown })
        .lastDailyReviewDayKey;
      const lastWeeklyReviewKey = (parsed.review as { lastWeeklyReviewKey?: unknown })
        .lastWeeklyReviewKey;
      state.review.lastDailyReviewDayKey =
        typeof lastDailyReviewDayKey === "string" && lastDailyReviewDayKey.trim()
          ? lastDailyReviewDayKey
          : undefined;
      state.review.lastWeeklyReviewKey =
        typeof lastWeeklyReviewKey === "string" && lastWeeklyReviewKey.trim()
          ? lastWeeklyReviewKey
          : undefined;
    }
    state.taskSignals =
      parsed.taskSignals && typeof parsed.taskSignals === "object" ? { ...parsed.taskSignals } : {};
    state.goals = Array.isArray(parsed.goals) ? parsed.goals : [];
    state.tasks = Array.isArray(parsed.tasks) ? parsed.tasks : [];
    state.recentEvents = Array.isArray(parsed.recentEvents)
      ? parsed.recentEvents.slice(-MAX_RECENT_EVENTS)
      : [];
    state.recentCycles = Array.isArray(parsed.recentCycles)
      ? parsed.recentCycles.slice(-MAX_RECENT_CYCLES)
      : [];
    state.metrics =
      parsed.metrics && typeof parsed.metrics === "object"
        ? {
            cycles: Number.isFinite(parsed.metrics.cycles) ? Math.max(0, parsed.metrics.cycles) : 0,
            ok: Number.isFinite(parsed.metrics.ok) ? Math.max(0, parsed.metrics.ok) : 0,
            error: Number.isFinite(parsed.metrics.error) ? Math.max(0, parsed.metrics.error) : 0,
            skipped: Number.isFinite(parsed.metrics.skipped)
              ? Math.max(0, parsed.metrics.skipped)
              : 0,
            consecutiveErrors: Number.isFinite(parsed.metrics.consecutiveErrors)
              ? Math.max(0, parsed.metrics.consecutiveErrors)
              : 0,
            lastCycleAt: Number.isFinite(parsed.metrics.lastCycleAt)
              ? parsed.metrics.lastCycleAt
              : undefined,
            lastError:
              typeof parsed.metrics.lastError === "string" ? parsed.metrics.lastError : undefined,
          }
        : state.metrics;
  }
  if (!state.paused) {
    state.pauseReason = undefined;
    state.pausedAt = undefined;
  } else if (!state.pauseReason) {
    state.pauseReason = "manual";
  }
  refreshAutonomyBudgetWindow(state);
  return state;
}

export async function saveAutonomyState(state: AutonomyState) {
  const statePath = resolveAutonomyStatePath(state.agentId);
  const payload = JSON.stringify(state, null, 2);
  await withSerializedWrite(statePath, async () => {
    await fs.mkdir(path.dirname(statePath), { recursive: true });
    const tmp = `${statePath}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
    await fs.writeFile(tmp, payload, "utf-8");
    await fs.rename(tmp, statePath);
  });
}

export async function enqueueAutonomyEvent(params: {
  agentId: string;
  source: AutonomyEventSource;
  type: string;
  dedupeKey?: string;
  payload?: Record<string, unknown>;
  ts?: number;
}): Promise<AutonomyEvent> {
  const event: AutonomyEvent = {
    id: crypto.randomUUID(),
    source: params.source,
    type: params.type.trim() || "event",
    ts: Number.isFinite(params.ts) ? (params.ts as number) : Date.now(),
    dedupeKey: normalizeOptionalString(params.dedupeKey),
    payload: params.payload,
  };
  const eventsPath = resolveAutonomyEventsPath(params.agentId);
  await withSerializedWrite(eventsPath, async () => {
    await fs.mkdir(path.dirname(eventsPath), { recursive: true });
    await fs.appendFile(eventsPath, `${JSON.stringify(event)}\n`, "utf-8");
  });
  return event;
}

export async function drainAutonomyEvents(params: {
  agentId: string;
  state: AutonomyState;
  maxEvents?: number;
  nowMs?: number;
}) {
  const eventsPath = resolveAutonomyEventsPath(params.agentId);
  const maxEvents = clampInt(params.maxEvents, 1, 500, params.state.maxQueuedEvents);
  const nowMs = Number.isFinite(params.nowMs) ? (params.nowMs as number) : Date.now();
  const raw = await fs.readFile(eventsPath, "utf-8").catch(() => "");
  if (!raw.trim()) {
    pruneDedupeMap(params.state, nowMs);
    return { events: [] as AutonomyEvent[], droppedDuplicates: 0, remaining: 0 };
  }

  const lines = raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const selected: AutonomyEvent[] = [];
  const remaining: AutonomyEvent[] = [];
  let droppedDuplicates = 0;
  for (const line of lines) {
    let parsed: AutonomyEvent | null = null;
    try {
      parsed = JSON.parse(line) as AutonomyEvent;
    } catch {
      parsed = null;
    }
    if (!parsed || typeof parsed !== "object") {
      continue;
    }
    const event: AutonomyEvent = {
      id: normalizeOptionalString(parsed.id) ?? crypto.randomUUID(),
      source: parsed.source,
      type: normalizeOptionalString(parsed.type) ?? "event",
      ts: Number.isFinite(parsed.ts) ? parsed.ts : nowMs,
      dedupeKey: normalizeOptionalString(parsed.dedupeKey),
      payload:
        parsed.payload && typeof parsed.payload === "object" && !Array.isArray(parsed.payload)
          ? parsed.payload
          : undefined,
    };

    if (selected.length >= maxEvents) {
      remaining.push(event);
      continue;
    }
    const key = resolveEventDedupeKey(event);
    const seenAt = params.state.dedupe[key];
    if (Number.isFinite(seenAt) && nowMs - seenAt < params.state.dedupeWindowMs) {
      droppedDuplicates += 1;
      continue;
    }
    params.state.dedupe[key] = nowMs;
    selected.push(event);
  }

  pruneDedupeMap(params.state, nowMs);

  const serializedRemaining =
    remaining.length > 0 ? `${remaining.map((event) => JSON.stringify(event)).join("\n")}\n` : "";
  await withSerializedWrite(eventsPath, async () => {
    await fs.mkdir(path.dirname(eventsPath), { recursive: true });
    await fs.writeFile(eventsPath, serializedRemaining, "utf-8");
  });

  return { events: selected, droppedDuplicates, remaining: remaining.length };
}

export function recordAutonomyCycle(state: AutonomyState, cycle: AutonomyCycleRecord) {
  refreshAutonomyBudgetWindow(state, cycle.ts);
  state.metrics.cycles += 1;
  state.metrics.lastCycleAt = cycle.ts;
  if (cycle.status !== "skipped") {
    state.budget.cyclesUsed += 1;
    if (cycle.tokenUsage && Number.isFinite(cycle.tokenUsage.total)) {
      state.budget.tokensUsed += Math.max(0, Math.floor(cycle.tokenUsage.total));
    }
  }
  if (cycle.status === "ok") {
    state.metrics.ok += 1;
    state.metrics.consecutiveErrors = 0;
  } else if (cycle.status === "error") {
    state.metrics.error += 1;
    state.metrics.lastError = cycle.error;
    state.metrics.consecutiveErrors += 1;
  } else {
    state.metrics.skipped += 1;
  }
  state.recentCycles = [...state.recentCycles, cycle].slice(-MAX_RECENT_CYCLES);
}

export function recordAutonomyEvents(state: AutonomyState, events: AutonomyEvent[]) {
  if (events.length === 0) {
    return;
  }
  state.recentEvents = [...state.recentEvents, ...events].slice(-MAX_RECENT_EVENTS);
}

function resolveWorkspaceFile(workspaceDir: string, filePath: string) {
  if (path.isAbsolute(filePath)) {
    return path.resolve(filePath);
  }
  return path.resolve(workspaceDir, filePath);
}

async function ensureFileIfMissing(filePath: string, initialContent: string) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const existing = await fs.readFile(filePath, "utf-8").catch(() => null);
  if (existing !== null) {
    return;
  }
  await fs.writeFile(filePath, initialContent, "utf-8");
}

export async function ensureAutonomyWorkspaceFiles(params: {
  workspaceDir: string;
  state: Pick<AutonomyState, "mission" | "goalsFile" | "tasksFile" | "logFile">;
}) {
  const goalsPath = resolveWorkspaceFile(params.workspaceDir, params.state.goalsFile);
  const tasksPath = resolveWorkspaceFile(params.workspaceDir, params.state.tasksFile);
  const logPath = resolveWorkspaceFile(params.workspaceDir, params.state.logFile);
  await ensureFileIfMissing(
    goalsPath,
    [
      "# Autonomy Goals",
      "",
      `Mission: ${params.state.mission}`,
      "",
      "## Active goals",
      "- (add goals with impact/urgency/confidence)",
      "",
    ].join("\n"),
  );
  await ensureFileIfMissing(
    tasksPath,
    [
      "# Autonomy Tasks",
      "",
      "Track task primitives here (CREATE/START/BLOCK/COMPLETE/CANCEL/FOLLOWUP).",
      "",
      "| id | title | status | priority | dependencies | owner |",
      "|---|---|---|---|---|---|",
      "",
    ].join("\n"),
  );
  await ensureFileIfMissing(
    logPath,
    ["# Autonomy Log", "", "Run-by-run execution notes, evidence, and trigger decisions.", ""].join(
      "\n",
    ),
  );
}

export async function appendAutonomyWorkspaceLog(params: {
  workspaceDir: string;
  logFile: string;
  nowMs: number;
  status: "ok" | "error" | "skipped";
  summary?: string;
  error?: string;
  processedEvents: AutonomyEvent[];
  droppedDuplicates?: number;
  remainingEvents?: number;
  budgetDayKey?: string;
  budgetCyclesUsed?: number;
  budgetTokensUsed?: number;
}) {
  const logPath = resolveWorkspaceFile(params.workspaceDir, params.logFile);
  const lines = [
    `## ${new Date(params.nowMs).toISOString()} - ${params.status.toUpperCase()}`,
    "",
    params.summary ? `Summary: ${params.summary}` : undefined,
    params.error ? `Error: ${params.error}` : undefined,
    `Processed events: ${params.processedEvents.length}`,
    typeof params.droppedDuplicates === "number"
      ? `Dropped duplicate events: ${params.droppedDuplicates}`
      : undefined,
    typeof params.remainingEvents === "number"
      ? `Queued events remaining: ${params.remainingEvents}`
      : undefined,
    typeof params.budgetCyclesUsed === "number" && params.budgetDayKey
      ? `Daily usage (${params.budgetDayKey}): cycles=${params.budgetCyclesUsed}${
          typeof params.budgetTokensUsed === "number" ? ` tokens=${params.budgetTokensUsed}` : ""
        }`
      : undefined,
    params.processedEvents.length > 0 ? "Event digest:" : undefined,
    ...params.processedEvents.map((event) => {
      const dedupe = event.dedupeKey ? ` (dedupe=${event.dedupeKey})` : "";
      return `- [${event.source}] ${event.type}${dedupe}`;
    }),
    "",
  ].filter((line): line is string => typeof line === "string");
  await withSerializedWrite(logPath, async () => {
    await fs.mkdir(path.dirname(logPath), { recursive: true });
    await fs.appendFile(logPath, `${lines.join("\n")}\n`, "utf-8");
  });
}
