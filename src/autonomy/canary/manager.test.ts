import { describe, expect, it } from "vitest";
import { evaluateCanaryHealth } from "./manager.js";

describe("canary manager", () => {
  it("rolls back on error-rate regression", () => {
    const result = evaluateCanaryHealth({
      errorRate: 0.08,
      maxErrorRate: 0.05,
      latencyP95Ms: 100,
      baselineLatencyP95Ms: 95,
      maxLatencyRegressionPct: 20,
    });
    expect(result.status).toBe("regressed");
    expect(result.shouldRollback).toBe(true);
  });

  it("rolls back on latency regression", () => {
    const result = evaluateCanaryHealth({
      errorRate: 0.01,
      maxErrorRate: 0.05,
      latencyP95Ms: 180,
      baselineLatencyP95Ms: 100,
      maxLatencyRegressionPct: 50,
    });
    expect(result.status).toBe("regressed");
    expect(result.shouldRollback).toBe(true);
  });

  it("marks canary healthy when metrics are within thresholds", () => {
    const result = evaluateCanaryHealth({
      errorRate: 0.01,
      maxErrorRate: 0.05,
      latencyP95Ms: 120,
      baselineLatencyP95Ms: 100,
      maxLatencyRegressionPct: 30,
    });
    expect(result.status).toBe("healthy");
    expect(result.shouldRollback).toBe(false);
  });
});
