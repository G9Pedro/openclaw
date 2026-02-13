import type { AutonomyAugmentationStage } from "../types.js";

export type AutonomyLedgerEventType =
  | "phase_enter"
  | "phase_exit"
  | "policy_denied"
  | "discovery_update"
  | "candidate_update"
  | "promotion"
  | "rollback";

export type AutonomyLedgerEntry = {
  id: string;
  agentId: string;
  ts: number;
  correlationId: string;
  eventType: AutonomyLedgerEventType;
  stage: AutonomyAugmentationStage;
  actor: string;
  summary: string;
  evidence?: Record<string, unknown>;
};
