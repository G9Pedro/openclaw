import { describe, expect, it } from "vitest";
import { getDefaultAutonomyEvalScenarios } from "./scenarios.js";

describe("autonomy eval scenarios", () => {
  it("returns baseline, adversarial, and regression packs", () => {
    const scenarios = getDefaultAutonomyEvalScenarios();
    expect(scenarios.length).toBeGreaterThanOrEqual(3);
    expect(new Set(scenarios.map((scenario) => scenario.kind))).toEqual(
      new Set(["baseline", "adversarial", "regression"]),
    );
  });
});
