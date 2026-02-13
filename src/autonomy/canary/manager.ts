export type CanaryEvaluationInput = {
  errorRate: number;
  maxErrorRate: number;
  latencyP95Ms: number;
  baselineLatencyP95Ms: number;
  maxLatencyRegressionPct: number;
};

export type CanaryEvaluationResult = {
  status: "healthy" | "regressed";
  reason: string;
  shouldRollback: boolean;
};

function clampNonNegative(value: number) {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

export function evaluateCanaryHealth(input: CanaryEvaluationInput): CanaryEvaluationResult {
  const errorRate = clampNonNegative(input.errorRate);
  const maxErrorRate = clampNonNegative(input.maxErrorRate);
  if (errorRate > maxErrorRate) {
    return {
      status: "regressed",
      reason: `error rate ${errorRate.toFixed(3)} exceeded max ${maxErrorRate.toFixed(3)}`,
      shouldRollback: true,
    };
  }

  const latencyP95Ms = clampNonNegative(input.latencyP95Ms);
  const baselineLatencyP95Ms = clampNonNegative(input.baselineLatencyP95Ms);
  const maxLatencyRegressionPct = clampNonNegative(input.maxLatencyRegressionPct);
  if (baselineLatencyP95Ms > 0) {
    const regressionPct = ((latencyP95Ms - baselineLatencyP95Ms) / baselineLatencyP95Ms) * 100;
    if (regressionPct > maxLatencyRegressionPct) {
      return {
        status: "regressed",
        reason: `latency regression ${regressionPct.toFixed(2)}% exceeded max ${maxLatencyRegressionPct.toFixed(2)}%`,
        shouldRollback: true,
      };
    }
  }

  return {
    status: "healthy",
    reason: "canary metrics within thresholds",
    shouldRollback: false,
  };
}
