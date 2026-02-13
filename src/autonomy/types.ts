export type AutonomyEventSource = "cron" | "webhook" | "email" | "subagent" | "manual";

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
};

export type AutonomyMetrics = {
  cycles: number;
  ok: number;
  error: number;
  skipped: number;
  lastCycleAt?: number;
  lastError?: string;
};

export type AutonomyState = {
  version: 1;
  agentId: string;
  mission: string;
  paused: boolean;
  goalsFile: string;
  tasksFile: string;
  logFile: string;
  maxActionsPerRun: number;
  dedupeWindowMs: number;
  maxQueuedEvents: number;
  dedupe: Record<string, number>;
  goals: AutonomyGoal[];
  tasks: AutonomyTask[];
  recentEvents: AutonomyEvent[];
  recentCycles: AutonomyCycleRecord[];
  metrics: AutonomyMetrics;
};
