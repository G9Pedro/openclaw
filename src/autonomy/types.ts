export type AutonomyEventSource = "cron" | "webhook" | "email" | "subagent" | "manual";

export type AutonomyExecutionClass = "read_only" | "reversible_write" | "destructive";

export type AutonomyEvent = {
  id: string;
  source: AutonomyEventSource;
  type: string;
  ts: number;
  dedupeKey?: string;
  payload?: Record<string, unknown>;
};

export type AutonomyTaskStatus = "pending" | "in_progress" | "blocked" | "completed" | "cancelled";

export type AutonomyTask = {
  id: string;
  title: string;
  status: AutonomyTaskStatus;
  priority: "low" | "medium" | "high" | "critical";
  dependencies: string[];
  owner: string;
  createdAt: number;
  updatedAt: number;
  evidence?: string[];
  blocker?: string;
};

export type AutonomyGoalStatus = "active" | "paused" | "completed" | "dropped";

export type AutonomyGoal = {
  id: string;
  title: string;
  status: AutonomyGoalStatus;
  impact: number;
  urgency: number;
  confidence: number;
  createdAt: number;
  updatedAt: number;
};

export type AutonomyCycleRecord = {
  ts: number;
  status: "ok" | "error" | "skipped";
  summary?: string;
  error?: string;
  processedEvents: number;
  durationMs: number;
  tokenUsage?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
};

export type AutonomyMetrics = {
  cycles: number;
  ok: number;
  error: number;
  skipped: number;
  consecutiveErrors: number;
  lastCycleAt?: number;
  lastError?: string;
};

export type AutonomySafetyPolicy = {
  dailyTokenBudget?: number;
  dailyCycleBudget?: number;
  maxConsecutiveErrors: number;
  autoPauseOnBudgetExhausted: boolean;
  autoResumeOnNewDayBudgetPause: boolean;
  errorPauseMinutes: number;
  staleTaskHours: number;
  emitDailyReviewEvents: boolean;
  emitWeeklyReviewEvents: boolean;
};

export type AutonomyBudgetUsage = {
  dayKey: string;
  cyclesUsed: number;
  tokensUsed: number;
};

export type AutonomyPauseReason = "manual" | "budget" | "errors";

export type AutonomyReviewState = {
  lastDailyReviewDayKey?: string;
  lastWeeklyReviewKey?: string;
};

export type AutonomyOperatorApproval = {
  action: string;
  approvedAt: number;
  expiresAt: number;
  source: AutonomyEventSource;
};

export type AutonomyAugmentationStage =
  | "discover"
  | "design"
  | "synthesize"
  | "verify"
  | "canary"
  | "promote"
  | "observe"
  | "learn"
  | "retire";

export type AutonomyAugmentationGapCategory =
  | "capability"
  | "quality"
  | "reliability"
  | "safety"
  | "cost"
  | "latency"
  | "unknown";

export type AutonomyAugmentationGapStatus = "open" | "planned" | "addressed" | "suppressed";

export type AutonomyAugmentationGap = {
  id: string;
  key: string;
  title: string;
  category: AutonomyAugmentationGapCategory;
  status: AutonomyAugmentationGapStatus;
  severity: number;
  confidence: number;
  score: number;
  occurrences: number;
  firstSeenAt: number;
  lastSeenAt: number;
  lastSource: AutonomyEventSource;
  evidence: string[];
};

export type AutonomySkillCandidateStatus = "candidate" | "planned" | "verified" | "rejected";

export type AutonomySkillCandidate = {
  id: string;
  sourceGapId: string;
  name: string;
  intent: string;
  status: AutonomySkillCandidateStatus;
  priority: number;
  createdAt: number;
  updatedAt: number;
  safety: {
    executionClass: AutonomyExecutionClass;
    constraints: string[];
  };
  tests: string[];
};

export type AutonomyExperimentStatus = "active" | "passed" | "failed" | "cancelled";

export type AutonomyAugmentationExperiment = {
  id: string;
  candidateId: string;
  status: AutonomyExperimentStatus;
  startedAt: number;
  updatedAt: number;
  resultSummary?: string;
};

export type AutonomyAugmentationTransition = {
  from: AutonomyAugmentationStage;
  to: AutonomyAugmentationStage;
  ts: number;
  reason: string;
};

export type AutonomyAugmentationState = {
  stage: AutonomyAugmentationStage;
  stageEnteredAt: number;
  lastTransitionAt: number;
  lastTransitionReason?: string;
  phaseRunCount: number;
  policyVersion: string;
  lastEvalScore?: number;
  lastEvalAt?: number;
  gaps: AutonomyAugmentationGap[];
  candidates: AutonomySkillCandidate[];
  activeExperiments: AutonomyAugmentationExperiment[];
  transitions: AutonomyAugmentationTransition[];
};

export type AutonomyState = {
  version: 1;
  agentId: string;
  mission: string;
  paused: boolean;
  pauseReason?: AutonomyPauseReason;
  pausedAt?: number;
  goalsFile: string;
  tasksFile: string;
  logFile: string;
  maxActionsPerRun: number;
  dedupeWindowMs: number;
  maxQueuedEvents: number;
  safety: AutonomySafetyPolicy;
  budget: AutonomyBudgetUsage;
  review: AutonomyReviewState;
  augmentation: AutonomyAugmentationState;
  approvals: Record<string, AutonomyOperatorApproval>;
  taskSignals: Record<string, string>;
  dedupe: Record<string, number>;
  goals: AutonomyGoal[];
  tasks: AutonomyTask[];
  recentEvents: AutonomyEvent[];
  recentCycles: AutonomyCycleRecord[];
  metrics: AutonomyMetrics;
};
