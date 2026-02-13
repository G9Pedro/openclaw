import type { AutonomyAugmentationGap, AutonomySkillCandidate } from "../types.js";
import { toSkillCandidate, validateSkillCandidatePlan } from "./schema.js";

const MAX_NEW_CANDIDATES_PER_RUN = 5;

function normalizeSkillName(title: string) {
  return title
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "")
    .slice(0, 48);
}

function buildConstraints(gap: AutonomyAugmentationGap) {
  const constraints = [
    "must be reversible and observable",
    "must not perform destructive actions without explicit approval",
  ];
  if (gap.category === "safety") {
    constraints.push("must include policy-deny regression tests");
  }
  if (gap.category === "reliability") {
    constraints.push("must include timeout and retry resilience checks");
  }
  return constraints;
}

function buildTests(gap: AutonomyAugmentationGap) {
  return [
    `unit: addresses gap ${gap.key}`,
    "unit: deterministic output for fixed input",
    "policy: blocked when execution policy denies required class",
  ];
}

function buildCandidateFromGap(
  gap: AutonomyAugmentationGap,
  nowMs: number,
): AutonomySkillCandidate {
  const normalizedName = normalizeSkillName(gap.title || gap.key || gap.id);
  const input = {
    id: `skill-${gap.id}`,
    sourceGapId: gap.id,
    name: `autonomy-${normalizedName || gap.id}`,
    intent: `Address gap: ${gap.title}`,
    status: "candidate" as const,
    priority: Math.max(1, Math.floor(gap.score)),
    createdAt: nowMs,
    updatedAt: nowMs,
    safety: {
      executionClass: "reversible_write" as const,
      constraints: buildConstraints(gap),
    },
    tests: buildTests(gap),
  };
  const validation = validateSkillCandidatePlan(input);
  if (!validation.ok) {
    throw new Error(`invalid generated skill candidate: ${validation.error}`);
  }
  return toSkillCandidate(input);
}

export function planSkillCandidates(params: {
  nowMs: number;
  gaps: AutonomyAugmentationGap[];
  existingCandidates: AutonomySkillCandidate[];
}) {
  const byGapId = new Map(
    params.existingCandidates.map((candidate) => [candidate.sourceGapId, candidate]),
  );
  const rankedGaps = params.gaps
    .filter((gap) => gap.status === "open")
    .toSorted(
      (a, b) => b.score - a.score || b.lastSeenAt - a.lastSeenAt || a.id.localeCompare(b.id),
    );

  const generated: AutonomySkillCandidate[] = [];
  for (const gap of rankedGaps) {
    if (generated.length >= MAX_NEW_CANDIDATES_PER_RUN) {
      break;
    }
    if (byGapId.has(gap.id)) {
      continue;
    }
    generated.push(buildCandidateFromGap(gap, params.nowMs));
  }

  const merged = [...params.existingCandidates, ...generated]
    .map((candidate) =>
      candidate.status === "candidate"
        ? {
            ...candidate,
            priority: Math.max(1, Math.floor(candidate.priority)),
          }
        : candidate,
    )
    .toSorted(
      (a, b) => b.priority - a.priority || a.createdAt - b.createdAt || a.id.localeCompare(b.id),
    );

  return {
    candidates: merged.slice(0, 250),
    generatedCount: generated.length,
  };
}
