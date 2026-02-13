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
const STATE_BACKUP_FILENAME = "state.backup.json";
const EVENTS_FILENAME = "events.jsonl";
const LOCK_FILENAME = "run.lock";
const MAX_RECENT_EVENTS = 50;
const MAX_RECENT_CYCLES = 50;
const MAX_EVENT_QUEUE_LINES = 5000;
const MAX_DEDUPE_ENTRIES = 5000;
const MAX_STORED_GOALS = 500;
const MAX_STORED_TASKS = 2000;
const MAX_AUGMENTATION_GAPS = 200;
const MAX_AUGMENTATION_CANDIDATES = 250;
const MAX_AUGMENTATION_EXPERIMENTS = 100;
const MAX_AUGMENTATION_TRANSITIONS = 200;
const DEFAULT_DEDUPE_WINDOW_MS = 60 * 60_000;
const DEFAULT_MAX_QUEUED_EVENTS = 100;
const DEFAULT_MAX_CONSECUTIVE_ERRORS = 5;
const DEFAULT_ERROR_PAUSE_MINUTES = 240;
const DEFAULT_STALE_TASK_HOURS = 24;
const DEFAULT_AUGMENTATION_POLICY_VERSION = "2026-02-13";

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
  augmentation?: Partial<AutonomyState["augmentation"]>;
  taskSignals?: AutonomyState["taskSignals"];
};

const AUGMENTATION_STAGES: AutonomyState["augmentation"]["stage"][] = [
  "discover",
  "design",
  "synthesize",
  "verify",
  "canary",
  "promote",
  "observe",
  "learn",
  "retire",
];

function isAugmentationStage(value: unknown): value is AutonomyState["augmentation"]["stage"] {
  return (
    typeof value === "string" &&
    AUGMENTATION_STAGES.includes(value as AutonomyState["augmentation"]["stage"])
  );
}

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

function tryParseAutonomyState(raw: string) {
  if (!raw.trim()) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<AutonomyState>;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function pruneDedupeMap(state: AutonomyState, nowMs: number) {
  const minTs = nowMs - Math.max(state.dedupeWindowMs * 3, state.dedupeWindowMs);
  for (const [key, ts] of Object.entries(state.dedupe)) {
    if (!Number.isFinite(ts) || ts < minTs) {
      delete state.dedupe[key];
    }
  }
  const entries = Object.entries(state.dedupe)
    .filter(([, ts]) => Number.isFinite(ts))
    .toSorted((a, b) => b[1] - a[1]);
  if (entries.length <= MAX_DEDUPE_ENTRIES) {
    return;
  }
  const allowed = new Set(entries.slice(0, MAX_DEDUPE_ENTRIES).map(([key]) => key));
  for (const key of Object.keys(state.dedupe)) {
    if (!allowed.has(key)) {
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
    augmentation: {
      stage: isAugmentationStage(defaults?.augmentation?.stage)
        ? defaults.augmentation.stage
        : "discover",
      stageEnteredAt:
        typeof defaults?.augmentation?.stageEnteredAt === "number" &&
        Number.isFinite(defaults.augmentation.stageEnteredAt)
          ? Math.max(0, Math.floor(defaults.augmentation.stageEnteredAt))
          : nowMs,
      lastTransitionAt:
        typeof defaults?.augmentation?.lastTransitionAt === "number" &&
        Number.isFinite(defaults.augmentation.lastTransitionAt)
          ? Math.max(0, Math.floor(defaults.augmentation.lastTransitionAt))
          : nowMs,
      lastTransitionReason:
        typeof defaults?.augmentation?.lastTransitionReason === "string" &&
        defaults.augmentation.lastTransitionReason.trim()
          ? defaults.augmentation.lastTransitionReason.trim()
          : undefined,
      phaseRunCount:
        typeof defaults?.augmentation?.phaseRunCount === "number" &&
        Number.isFinite(defaults.augmentation.phaseRunCount)
          ? Math.max(0, Math.floor(defaults.augmentation.phaseRunCount))
          : 0,
      policyVersion:
        typeof defaults?.augmentation?.policyVersion === "string" &&
        defaults.augmentation.policyVersion.trim()
          ? defaults.augmentation.policyVersion.trim()
          : DEFAULT_AUGMENTATION_POLICY_VERSION,
      gaps: [],
      candidates: [],
      activeExperiments: [],
      transitions: [],
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

export function resolveAutonomyStateBackupPath(agentId: string) {
  return path.join(resolveAutonomyAgentDir(agentId), STATE_BACKUP_FILENAME);
}

export function resolveAutonomyEventsPath(agentId: string) {
  return path.join(resolveAutonomyAgentDir(agentId), EVENTS_FILENAME);
}

export function resolveAutonomyLockPath(agentId: string) {
  return path.join(resolveAutonomyAgentDir(agentId), LOCK_FILENAME);
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
  const backupPath = resolveAutonomyStateBackupPath(params.agentId);
  const raw = await fs.readFile(statePath, "utf-8").catch(() => "");
  const parsedPrimary = tryParseAutonomyState(raw);
  const parsedBackup =
    parsedPrimary ?? tryParseAutonomyState(await fs.readFile(backupPath, "utf-8").catch(() => ""));
  if (!raw.trim() && !parsedBackup) {
    const state = buildDefaultState(params.agentId, params.defaults);
    await saveAutonomyState(state);
    return state;
  }
  const parsed = parsedBackup;
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
    if (parsed.augmentation && typeof parsed.augmentation === "object") {
      const stageRaw = (parsed.augmentation as { stage?: unknown }).stage;
      const stageEnteredAtRaw = (parsed.augmentation as { stageEnteredAt?: unknown })
        .stageEnteredAt;
      const lastTransitionAtRaw = (parsed.augmentation as { lastTransitionAt?: unknown })
        .lastTransitionAt;
      const lastTransitionReasonRaw = (parsed.augmentation as { lastTransitionReason?: unknown })
        .lastTransitionReason;
      const phaseRunCountRaw = (parsed.augmentation as { phaseRunCount?: unknown }).phaseRunCount;
      const policyVersionRaw = (parsed.augmentation as { policyVersion?: unknown }).policyVersion;
      state.augmentation.stage = isAugmentationStage(stageRaw)
        ? stageRaw
        : state.augmentation.stage;
      state.augmentation.stageEnteredAt =
        typeof stageEnteredAtRaw === "number" && Number.isFinite(stageEnteredAtRaw)
          ? Math.max(0, Math.floor(stageEnteredAtRaw))
          : state.augmentation.stageEnteredAt;
      state.augmentation.lastTransitionAt =
        typeof lastTransitionAtRaw === "number" && Number.isFinite(lastTransitionAtRaw)
          ? Math.max(0, Math.floor(lastTransitionAtRaw))
          : state.augmentation.lastTransitionAt;
      state.augmentation.lastTransitionReason =
        typeof lastTransitionReasonRaw === "string" && lastTransitionReasonRaw.trim()
          ? lastTransitionReasonRaw.trim()
          : undefined;
      state.augmentation.phaseRunCount =
        typeof phaseRunCountRaw === "number" && Number.isFinite(phaseRunCountRaw)
          ? Math.max(0, Math.floor(phaseRunCountRaw))
          : state.augmentation.phaseRunCount;
      state.augmentation.policyVersion =
        typeof policyVersionRaw === "string" && policyVersionRaw.trim()
          ? policyVersionRaw.trim()
          : state.augmentation.policyVersion;

      const gapsRaw = (parsed.augmentation as { gaps?: unknown }).gaps;
      if (Array.isArray(gapsRaw)) {
        state.augmentation.gaps = gapsRaw
          .map((raw) => {
            if (!raw || typeof raw !== "object") {
              return null;
            }
            const id = normalizeOptionalString((raw as { id?: unknown }).id);
            const key = normalizeOptionalString((raw as { key?: unknown }).key);
            const title = normalizeOptionalString((raw as { title?: unknown }).title);
            const category = normalizeOptionalString((raw as { category?: unknown }).category);
            const status = normalizeOptionalString((raw as { status?: unknown }).status);
            const lastSource = normalizeOptionalString(
              (raw as { lastSource?: unknown }).lastSource,
            );
            if (!id || !key || !title || !category || !status || !lastSource) {
              return null;
            }
            if (
              category !== "capability" &&
              category !== "quality" &&
              category !== "reliability" &&
              category !== "safety" &&
              category !== "cost" &&
              category !== "latency" &&
              category !== "unknown"
            ) {
              return null;
            }
            if (
              status !== "open" &&
              status !== "planned" &&
              status !== "addressed" &&
              status !== "suppressed"
            ) {
              return null;
            }
            if (
              lastSource !== "cron" &&
              lastSource !== "webhook" &&
              lastSource !== "email" &&
              lastSource !== "subagent" &&
              lastSource !== "manual"
            ) {
              return null;
            }
            const evidence = Array.isArray((raw as { evidence?: unknown }).evidence)
              ? ((raw as { evidence?: unknown[] }).evidence ?? [])
                  .filter(
                    (value): value is string =>
                      typeof value === "string" && value.trim().length > 0,
                  )
                  .slice(-10)
              : [];
            return {
              id,
              key,
              title,
              category,
              status,
              severity: clampInt(
                typeof (raw as { severity?: unknown }).severity === "number"
                  ? ((raw as { severity?: number }).severity ?? 0)
                  : undefined,
                0,
                100,
                0,
              ),
              confidence:
                typeof (raw as { confidence?: unknown }).confidence === "number" &&
                Number.isFinite((raw as { confidence?: number }).confidence)
                  ? Math.max(0, Math.min(1, (raw as { confidence?: number }).confidence as number))
                  : 0,
              score: clampInt(
                typeof (raw as { score?: unknown }).score === "number"
                  ? ((raw as { score?: number }).score ?? 0)
                  : undefined,
                0,
                10_000,
                0,
              ),
              occurrences: clampInt(
                typeof (raw as { occurrences?: unknown }).occurrences === "number"
                  ? ((raw as { occurrences?: number }).occurrences ?? 0)
                  : undefined,
                1,
                1_000_000,
                1,
              ),
              firstSeenAt: clampInt(
                typeof (raw as { firstSeenAt?: unknown }).firstSeenAt === "number"
                  ? ((raw as { firstSeenAt?: number }).firstSeenAt ?? 0)
                  : undefined,
                0,
                Number.MAX_SAFE_INTEGER,
                Date.now(),
              ),
              lastSeenAt: clampInt(
                typeof (raw as { lastSeenAt?: unknown }).lastSeenAt === "number"
                  ? ((raw as { lastSeenAt?: number }).lastSeenAt ?? 0)
                  : undefined,
                0,
                Number.MAX_SAFE_INTEGER,
                Date.now(),
              ),
              lastSource,
              evidence,
            };
          })
          .filter((gap): gap is NonNullable<typeof gap> => gap !== null)
          .toSorted((a, b) => b.score - a.score || b.lastSeenAt - a.lastSeenAt)
          .slice(0, MAX_AUGMENTATION_GAPS);
      }

      const candidatesRaw = (parsed.augmentation as { candidates?: unknown }).candidates;
      if (Array.isArray(candidatesRaw)) {
        state.augmentation.candidates = candidatesRaw
          .map((raw) => {
            if (!raw || typeof raw !== "object") {
              return null;
            }
            const id = normalizeOptionalString((raw as { id?: unknown }).id);
            const sourceGapId = normalizeOptionalString(
              (raw as { sourceGapId?: unknown }).sourceGapId,
            );
            const name = normalizeOptionalString((raw as { name?: unknown }).name);
            const intent = normalizeOptionalString((raw as { intent?: unknown }).intent);
            const status = normalizeOptionalString((raw as { status?: unknown }).status);
            if (!id || !sourceGapId || !name || !intent || !status) {
              return null;
            }
            if (
              status !== "candidate" &&
              status !== "planned" &&
              status !== "verified" &&
              status !== "rejected"
            ) {
              return null;
            }
            const executionClass = normalizeOptionalString(
              (raw as { safety?: { executionClass?: unknown } }).safety?.executionClass,
            );
            if (
              executionClass !== "read_only" &&
              executionClass !== "reversible_write" &&
              executionClass !== "destructive"
            ) {
              return null;
            }
            const constraintsRaw = (raw as { safety?: { constraints?: unknown } }).safety
              ?.constraints;
            const testsRaw = (raw as { tests?: unknown }).tests;
            const constraints = Array.isArray(constraintsRaw)
              ? constraintsRaw
                  .filter(
                    (value): value is string =>
                      typeof value === "string" && value.trim().length > 0,
                  )
                  .slice(-20)
              : [];
            const tests = Array.isArray(testsRaw)
              ? testsRaw
                  .filter(
                    (value): value is string =>
                      typeof value === "string" && value.trim().length > 0,
                  )
                  .slice(-20)
              : [];
            return {
              id,
              sourceGapId,
              name,
              intent,
              status,
              priority: clampInt(
                typeof (raw as { priority?: unknown }).priority === "number"
                  ? ((raw as { priority?: number }).priority ?? 0)
                  : undefined,
                0,
                10_000,
                0,
              ),
              createdAt: clampInt(
                typeof (raw as { createdAt?: unknown }).createdAt === "number"
                  ? ((raw as { createdAt?: number }).createdAt ?? 0)
                  : undefined,
                0,
                Number.MAX_SAFE_INTEGER,
                Date.now(),
              ),
              updatedAt: clampInt(
                typeof (raw as { updatedAt?: unknown }).updatedAt === "number"
                  ? ((raw as { updatedAt?: number }).updatedAt ?? 0)
                  : undefined,
                0,
                Number.MAX_SAFE_INTEGER,
                Date.now(),
              ),
              safety: {
                executionClass,
                constraints,
              },
              tests,
            };
          })
          .filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null)
          .toSorted((a, b) => b.priority - a.priority || a.createdAt - b.createdAt)
          .slice(0, MAX_AUGMENTATION_CANDIDATES);
      }

      const experimentsRaw = (parsed.augmentation as { activeExperiments?: unknown })
        .activeExperiments;
      if (Array.isArray(experimentsRaw)) {
        state.augmentation.activeExperiments = experimentsRaw
          .map((raw) => {
            if (!raw || typeof raw !== "object") {
              return null;
            }
            const id = normalizeOptionalString((raw as { id?: unknown }).id);
            const candidateId = normalizeOptionalString(
              (raw as { candidateId?: unknown }).candidateId,
            );
            const status = normalizeOptionalString((raw as { status?: unknown }).status);
            if (!id || !candidateId || !status) {
              return null;
            }
            if (
              status !== "active" &&
              status !== "passed" &&
              status !== "failed" &&
              status !== "cancelled"
            ) {
              return null;
            }
            return {
              id,
              candidateId,
              status,
              startedAt: clampInt(
                typeof (raw as { startedAt?: unknown }).startedAt === "number"
                  ? ((raw as { startedAt?: number }).startedAt ?? 0)
                  : undefined,
                0,
                Number.MAX_SAFE_INTEGER,
                Date.now(),
              ),
              updatedAt: clampInt(
                typeof (raw as { updatedAt?: unknown }).updatedAt === "number"
                  ? ((raw as { updatedAt?: number }).updatedAt ?? 0)
                  : undefined,
                0,
                Number.MAX_SAFE_INTEGER,
                Date.now(),
              ),
              resultSummary: normalizeOptionalString(
                (raw as { resultSummary?: unknown }).resultSummary,
              ),
            };
          })
          .filter((experiment): experiment is NonNullable<typeof experiment> => experiment !== null)
          .slice(-MAX_AUGMENTATION_EXPERIMENTS);
      }

      const transitionsRaw = (parsed.augmentation as { transitions?: unknown }).transitions;
      if (Array.isArray(transitionsRaw)) {
        state.augmentation.transitions = transitionsRaw
          .map((raw) => {
            if (!raw || typeof raw !== "object") {
              return null;
            }
            const from = normalizeOptionalString((raw as { from?: unknown }).from);
            const to = normalizeOptionalString((raw as { to?: unknown }).to);
            const reason = normalizeOptionalString((raw as { reason?: unknown }).reason);
            if (!from || !to || !reason || !isAugmentationStage(from) || !isAugmentationStage(to)) {
              return null;
            }
            const tsRaw = (raw as { ts?: unknown }).ts;
            if (typeof tsRaw !== "number" || !Number.isFinite(tsRaw)) {
              return null;
            }
            return {
              from,
              to,
              reason,
              ts: Math.max(0, Math.floor(tsRaw)),
            };
          })
          .filter((transition): transition is NonNullable<typeof transition> => transition !== null)
          .slice(-MAX_AUGMENTATION_TRANSITIONS);
      }
    }
    state.taskSignals =
      parsed.taskSignals && typeof parsed.taskSignals === "object" ? { ...parsed.taskSignals } : {};
    state.goals = Array.isArray(parsed.goals) ? parsed.goals.slice(-MAX_STORED_GOALS) : [];
    state.tasks = Array.isArray(parsed.tasks) ? parsed.tasks.slice(-MAX_STORED_TASKS) : [];
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
  pruneDedupeMap(state, Date.now());
  refreshAutonomyBudgetWindow(state);
  if (!parsed) {
    await saveAutonomyState(state);
  }
  return state;
}

export async function saveAutonomyState(state: AutonomyState) {
  const statePath = resolveAutonomyStatePath(state.agentId);
  const backupPath = resolveAutonomyStateBackupPath(state.agentId);
  const payload = JSON.stringify(state, null, 2);
  await withSerializedWrite(statePath, async () => {
    await fs.mkdir(path.dirname(statePath), { recursive: true });
    const tmp = `${statePath}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
    await fs.writeFile(tmp, payload, "utf-8");
    await fs.rename(tmp, statePath);
    await fs.writeFile(backupPath, payload, "utf-8");
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
    return {
      events: [] as AutonomyEvent[],
      droppedDuplicates: 0,
      droppedInvalid: 0,
      droppedOverflow: 0,
      remaining: 0,
    };
  }

  const allLines = raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const droppedOverflow = Math.max(0, allLines.length - MAX_EVENT_QUEUE_LINES);
  const lines = droppedOverflow > 0 ? allLines.slice(-MAX_EVENT_QUEUE_LINES) : allLines;
  const selected: AutonomyEvent[] = [];
  const remaining: AutonomyEvent[] = [];
  let droppedDuplicates = 0;
  let droppedInvalid = 0;
  for (const line of lines) {
    let parsed: AutonomyEvent | null = null;
    try {
      parsed = JSON.parse(line) as AutonomyEvent;
    } catch {
      parsed = null;
    }
    if (!parsed || typeof parsed !== "object") {
      droppedInvalid += 1;
      continue;
    }
    const sourceRaw = (parsed as { source?: unknown }).source;
    const source =
      sourceRaw === "cron" ||
      sourceRaw === "webhook" ||
      sourceRaw === "email" ||
      sourceRaw === "subagent" ||
      sourceRaw === "manual"
        ? sourceRaw
        : "manual";
    const event: AutonomyEvent = {
      id: normalizeOptionalString(parsed.id) ?? crypto.randomUUID(),
      source,
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

  return {
    events: selected,
    droppedDuplicates,
    droppedInvalid,
    droppedOverflow,
    remaining: remaining.length,
  };
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
  droppedInvalid?: number;
  droppedOverflow?: number;
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
    typeof params.droppedInvalid === "number"
      ? `Dropped invalid events: ${params.droppedInvalid}`
      : undefined,
    typeof params.droppedOverflow === "number"
      ? `Dropped overflow events: ${params.droppedOverflow}`
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
