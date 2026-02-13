import type { AutonomyAugmentationStage, AutonomyEvent } from "./types.js";

export type AutonomyAugmentationEventType =
  | "autonomy.augmentation.phase.enter"
  | "autonomy.augmentation.phase.exit"
  | "autonomy.augmentation.policy.denied"
  | "autonomy.augmentation.discovery.updated"
  | "autonomy.augmentation.candidates.updated";

export function createAugmentationPhaseEnterEvent(params: {
  stage: AutonomyAugmentationStage;
  nowMs: number;
  reason: string;
}): AutonomyEvent {
  return {
    id: `augmentation-enter-${params.stage}-${params.nowMs}`,
    source: "manual",
    type: "autonomy.augmentation.phase.enter",
    ts: params.nowMs,
    dedupeKey: `autonomy.augmentation.phase.enter:${params.stage}:${Math.floor(params.nowMs / 60_000)}`,
    payload: {
      stage: params.stage,
      reason: params.reason,
    },
  };
}

export function createAugmentationPhaseExitEvent(params: {
  stage: AutonomyAugmentationStage;
  nowMs: number;
  reason: string;
}): AutonomyEvent {
  return {
    id: `augmentation-exit-${params.stage}-${params.nowMs}`,
    source: "manual",
    type: "autonomy.augmentation.phase.exit",
    ts: params.nowMs,
    dedupeKey: `autonomy.augmentation.phase.exit:${params.stage}:${Math.floor(params.nowMs / 60_000)}`,
    payload: {
      stage: params.stage,
      reason: params.reason,
    },
  };
}

export function createAugmentationPolicyDeniedEvent(params: {
  stage: AutonomyAugmentationStage;
  executionClass: string;
  nowMs: number;
  reason: string;
}): AutonomyEvent {
  return {
    id: `augmentation-policy-denied-${params.stage}-${params.nowMs}`,
    source: "manual",
    type: "autonomy.augmentation.policy.denied",
    ts: params.nowMs,
    dedupeKey: `autonomy.augmentation.policy.denied:${params.stage}:${Math.floor(params.nowMs / 60_000)}`,
    payload: {
      stage: params.stage,
      executionClass: params.executionClass,
      reason: params.reason,
    },
  };
}

export function createDiscoveryUpdatedEvent(params: {
  nowMs: number;
  signals: number;
  openGaps: number;
}): AutonomyEvent {
  return {
    id: `augmentation-discovery-${params.nowMs}`,
    source: "manual",
    type: "autonomy.augmentation.discovery.updated",
    ts: params.nowMs,
    dedupeKey: `autonomy.augmentation.discovery.updated:${Math.floor(params.nowMs / 60_000)}`,
    payload: {
      signals: params.signals,
      openGaps: params.openGaps,
    },
  };
}

export function createCandidatesUpdatedEvent(params: {
  nowMs: number;
  generated: number;
  totalCandidates: number;
}): AutonomyEvent {
  return {
    id: `augmentation-candidates-${params.nowMs}`,
    source: "manual",
    type: "autonomy.augmentation.candidates.updated",
    ts: params.nowMs,
    dedupeKey: `autonomy.augmentation.candidates.updated:${Math.floor(params.nowMs / 60_000)}`,
    payload: {
      generated: params.generated,
      totalCandidates: params.totalCandidates,
    },
  };
}
