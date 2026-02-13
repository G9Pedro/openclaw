export type PromotionGateInput = {
  verifiedCandidateCount: number;
  recentCycleCount: number;
  recentErrorCount: number;
  canaryStatus?: "healthy" | "regressed";
  evalScore?: number;
  minimumRecentCycles?: number;
  maximumErrorRate?: number;
  minimumEvalScore?: number;
};

export type PromotionGateResult = {
  passed: boolean;
  reason: string;
  errorRate: number;
};

function normalizeCount(value: number | undefined) {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value as number)) : 0;
}

export function evaluatePromotionGates(input: PromotionGateInput): PromotionGateResult {
  const verifiedCandidateCount = normalizeCount(input.verifiedCandidateCount);
  const recentCycleCount = normalizeCount(input.recentCycleCount);
  const recentErrorCount = normalizeCount(input.recentErrorCount);
  const minimumRecentCycles = Number.isFinite(input.minimumRecentCycles)
    ? Math.max(1, Math.floor(input.minimumRecentCycles as number))
    : 3;
  const maximumErrorRate = Number.isFinite(input.maximumErrorRate)
    ? Math.max(0, Math.min(1, input.maximumErrorRate as number))
    : 0.2;
  const minimumEvalScore = Number.isFinite(input.minimumEvalScore)
    ? Math.max(0, Math.min(1, input.minimumEvalScore as number))
    : 0.6;
  const evalScore = Number.isFinite(input.evalScore)
    ? Math.max(0, Math.min(1, input.evalScore as number))
    : 0;
  const errorRate = recentCycleCount > 0 ? recentErrorCount / recentCycleCount : 1;

  if (verifiedCandidateCount <= 0) {
    return {
      passed: false,
      reason: "no verified candidates available for promotion",
      errorRate,
    };
  }
  if (recentCycleCount < minimumRecentCycles) {
    return {
      passed: false,
      reason: `insufficient recent cycles (${recentCycleCount}/${minimumRecentCycles})`,
      errorRate,
    };
  }
  if (errorRate > maximumErrorRate) {
    return {
      passed: false,
      reason: `recent error rate ${errorRate.toFixed(3)} exceeded max ${maximumErrorRate.toFixed(3)}`,
      errorRate,
    };
  }
  if (input.canaryStatus === "regressed") {
    return {
      passed: false,
      reason: "canary status regressed",
      errorRate,
    };
  }
  if (evalScore < minimumEvalScore) {
    return {
      passed: false,
      reason: `long horizon eval score ${evalScore.toFixed(3)} below minimum ${minimumEvalScore.toFixed(3)}`,
      errorRate,
    };
  }
  return {
    passed: true,
    reason: "promotion gates passed",
    errorRate,
  };
}
