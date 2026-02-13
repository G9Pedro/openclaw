import type { AutonomyAugmentationStage, AutonomyExecutionClass, AutonomyState } from "./types.js";

export const AUGMENTATION_STAGE_ORDER: AutonomyAugmentationStage[] = [
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

const NEXT_STAGE_BY_CURRENT: Record<AutonomyAugmentationStage, AutonomyAugmentationStage> = {
  discover: "design",
  design: "synthesize",
  synthesize: "verify",
  verify: "canary",
  canary: "promote",
  promote: "observe",
  observe: "learn",
  learn: "retire",
  retire: "discover",
};

function resolveStageOrderIndex(stage: AutonomyAugmentationStage) {
  return AUGMENTATION_STAGE_ORDER.indexOf(stage);
}

export function isValidAugmentationTransition(
  from: AutonomyAugmentationStage,
  to: AutonomyAugmentationStage,
) {
  if (from === to) {
    return true;
  }
  return NEXT_STAGE_BY_CURRENT[from] === to;
}

export function transitionAugmentationStage(
  state: AutonomyState,
  to: AutonomyAugmentationStage,
  reason: string,
  nowMs = Date.now(),
) {
  const from = state.augmentation.stage;
  if (!isValidAugmentationTransition(from, to)) {
    throw new Error(`invalid augmentation stage transition: ${from} -> ${to}`);
  }
  if (from === to) {
    return { changed: false, from, to };
  }
  state.augmentation.stage = to;
  state.augmentation.stageEnteredAt = nowMs;
  state.augmentation.lastTransitionAt = nowMs;
  state.augmentation.lastTransitionReason = reason;
  state.augmentation.transitions = [
    ...state.augmentation.transitions,
    { from, to, ts: nowMs, reason },
  ].slice(-200);
  return { changed: true, from, to };
}

export function resolveExecutionClassForStage(
  stage: AutonomyAugmentationStage,
): AutonomyExecutionClass {
  if (stage === "promote" || stage === "retire") {
    return "destructive";
  }
  if (stage === "synthesize" || stage === "verify" || stage === "canary") {
    return "reversible_write";
  }
  return "read_only";
}

export function resolveNextAugmentationStage(state: AutonomyState): AutonomyAugmentationStage {
  const current = state.augmentation.stage;
  const hasOpenGaps = state.augmentation.gaps.some((gap) => gap.status === "open");
  const hasCandidates = state.augmentation.candidates.some(
    (candidate) => candidate.status === "candidate" || candidate.status === "planned",
  );
  const hasVerifiedCandidates = state.augmentation.candidates.some(
    (candidate) => candidate.status === "verified",
  );

  if (current === "discover") {
    return hasOpenGaps ? "design" : "discover";
  }
  if (current === "design") {
    return hasCandidates ? "synthesize" : "discover";
  }
  if (current === "synthesize") {
    return hasCandidates ? "verify" : "discover";
  }
  if (current === "verify") {
    return hasVerifiedCandidates ? "canary" : "discover";
  }
  if (current === "canary") {
    return hasVerifiedCandidates ? "promote" : "discover";
  }
  if (current === "promote") {
    return "observe";
  }
  if (current === "observe") {
    return "learn";
  }
  if (current === "learn") {
    return "retire";
  }
  return "discover";
}

export function compareAugmentationStage(
  a: AutonomyAugmentationStage,
  b: AutonomyAugmentationStage,
) {
  return resolveStageOrderIndex(a) - resolveStageOrderIndex(b);
}
