import { describe, expect, it } from "vitest";
import { evaluatePromotionGates } from "./gates.js";

describe("promotion gates", () => {
  it("fails when no verified candidates exist", () => {
    const result = evaluatePromotionGates({
      verifiedCandidateCount: 0,
      recentCycleCount: 5,
      recentErrorCount: 0,
      canaryStatus: "healthy",
    });
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("no verified candidates");
  });

  it("fails on high error rate", () => {
    const result = evaluatePromotionGates({
      verifiedCandidateCount: 2,
      recentCycleCount: 5,
      recentErrorCount: 3,
      canaryStatus: "healthy",
      maximumErrorRate: 0.2,
    });
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("error rate");
  });

  it("passes when all gates are satisfied", () => {
    const result = evaluatePromotionGates({
      verifiedCandidateCount: 2,
      recentCycleCount: 5,
      recentErrorCount: 0,
      canaryStatus: "healthy",
      maximumErrorRate: 0.2,
    });
    expect(result.passed).toBe(true);
  });
});
