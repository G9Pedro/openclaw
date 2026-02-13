import type { AutonomyExecutionClass } from "../types.js";

export type AutonomyPolicyApprovalLevel = "none" | "operator";

export type AutonomyPolicyRuntimeConfig = {
  version: string;
  destructiveActionsRequireApproval: boolean;
  reversibleWriteActionsRequireApproval: boolean;
  actionClassOverrides: Record<string, AutonomyExecutionClass>;
  explicitAllowActions: string[];
  explicitDenyActions: string[];
};

export type AutonomyPolicyDecision = {
  allowed: boolean;
  action: string;
  executionClass: AutonomyExecutionClass;
  approvalLevel: AutonomyPolicyApprovalLevel;
  policyVersion: string;
  reason: string;
};
