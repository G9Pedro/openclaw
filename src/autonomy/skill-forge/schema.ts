import type {
  AutonomyExecutionClass,
  AutonomySkillCandidate,
  AutonomySkillCandidateStatus,
} from "../types.js";

export type SkillCandidatePlanInput = {
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

function isNonEmptyString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0;
}

export function validateSkillCandidatePlan(
  input: SkillCandidatePlanInput,
): { ok: true } | { ok: false; error: string } {
  if (!isNonEmptyString(input.id)) {
    return { ok: false, error: "candidate id is required" };
  }
  if (!isNonEmptyString(input.sourceGapId)) {
    return { ok: false, error: "sourceGapId is required" };
  }
  if (!isNonEmptyString(input.name)) {
    return { ok: false, error: "name is required" };
  }
  if (!isNonEmptyString(input.intent)) {
    return { ok: false, error: "intent is required" };
  }
  if (!Number.isFinite(input.priority) || input.priority < 0) {
    return { ok: false, error: "priority must be a non-negative number" };
  }
  if (!Array.isArray(input.safety.constraints) || input.safety.constraints.length === 0) {
    return { ok: false, error: "safety constraints are required" };
  }
  if (
    input.safety.executionClass !== "read_only" &&
    input.safety.executionClass !== "reversible_write" &&
    input.safety.executionClass !== "destructive"
  ) {
    return { ok: false, error: "invalid execution class" };
  }
  if (!Array.isArray(input.tests) || input.tests.length === 0) {
    return { ok: false, error: "tests are required" };
  }
  return { ok: true };
}

export function toSkillCandidate(input: SkillCandidatePlanInput): AutonomySkillCandidate {
  return {
    id: input.id.trim(),
    sourceGapId: input.sourceGapId.trim(),
    name: input.name.trim(),
    intent: input.intent.trim(),
    status: input.status,
    priority: Math.max(0, Math.floor(input.priority)),
    createdAt: Math.max(0, Math.floor(input.createdAt)),
    updatedAt: Math.max(0, Math.floor(input.updatedAt)),
    safety: {
      executionClass: input.safety.executionClass,
      constraints: input.safety.constraints.map((constraint) => constraint.trim()).filter(Boolean),
    },
    tests: input.tests.map((test) => test.trim()).filter(Boolean),
  };
}
