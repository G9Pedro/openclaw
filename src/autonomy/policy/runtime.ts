import type { AutonomyExecutionClass } from "../types.js";
import type { AutonomyPolicyDecision, AutonomyPolicyRuntimeConfig } from "./types.js";

export const DEFAULT_AUTONOMY_POLICY_VERSION = "2026-02-13";

export function createDefaultAutonomyPolicyConfig(
  partial?: Partial<AutonomyPolicyRuntimeConfig>,
): AutonomyPolicyRuntimeConfig {
  return {
    version: partial?.version?.trim() || DEFAULT_AUTONOMY_POLICY_VERSION,
    destructiveActionsRequireApproval: partial?.destructiveActionsRequireApproval !== false,
    reversibleWriteActionsRequireApproval: partial?.reversibleWriteActionsRequireApproval === true,
    actionClassOverrides: { ...(partial?.actionClassOverrides ?? {}) },
    explicitAllowActions: [...(partial?.explicitAllowActions ?? [])],
    explicitDenyActions: [...(partial?.explicitDenyActions ?? [])],
  };
}

export function resolveAutonomyActionClass(params: {
  action: string;
  fallbackClass: AutonomyExecutionClass;
  config: AutonomyPolicyRuntimeConfig;
}) {
  return params.config.actionClassOverrides[params.action] ?? params.fallbackClass;
}

export function evaluateAutonomyPolicy(params: {
  action: string;
  executionClass: AutonomyExecutionClass;
  config: AutonomyPolicyRuntimeConfig;
  approvedByOperator?: boolean;
}): AutonomyPolicyDecision {
  const approved = params.approvedByOperator === true;
  const deniedByList = params.config.explicitDenyActions.includes(params.action);
  const allowedByList = params.config.explicitAllowActions.includes(params.action);

  if (deniedByList) {
    return {
      allowed: false,
      action: params.action,
      executionClass: params.executionClass,
      approvalLevel: "operator",
      policyVersion: params.config.version,
      reason: "action is explicitly denied by policy",
    };
  }

  if (allowedByList && params.executionClass === "read_only") {
    return {
      allowed: true,
      action: params.action,
      executionClass: params.executionClass,
      approvalLevel: "none",
      policyVersion: params.config.version,
      reason: "action explicitly allowed by policy",
    };
  }

  if (
    params.executionClass === "destructive" &&
    params.config.destructiveActionsRequireApproval &&
    !approved
  ) {
    return {
      allowed: false,
      action: params.action,
      executionClass: params.executionClass,
      approvalLevel: "operator",
      policyVersion: params.config.version,
      reason: "destructive action requires operator approval",
    };
  }

  if (
    params.executionClass === "reversible_write" &&
    params.config.reversibleWriteActionsRequireApproval &&
    !approved
  ) {
    return {
      allowed: false,
      action: params.action,
      executionClass: params.executionClass,
      approvalLevel: "operator",
      policyVersion: params.config.version,
      reason: "reversible write action requires operator approval",
    };
  }

  return {
    allowed: true,
    action: params.action,
    executionClass: params.executionClass,
    approvalLevel: "none",
    policyVersion: params.config.version,
    reason: "action allowed by policy",
  };
}
