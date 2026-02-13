import { describe, expect, it } from "vitest";
import {
  createDefaultAutonomyPolicyConfig,
  evaluateAutonomyPolicy,
  resolveAutonomyActionClass,
} from "./runtime.js";

describe("autonomy policy runtime", () => {
  it("denies destructive actions without approval by default", () => {
    const config = createDefaultAutonomyPolicyConfig();
    const decision = evaluateAutonomyPolicy({
      action: "autonomy.stage.promote",
      executionClass: "destructive",
      config,
    });
    expect(decision.allowed).toBe(false);
  });

  it("denies unknown actions through explicit deny list", () => {
    const config = createDefaultAutonomyPolicyConfig({
      explicitDenyActions: ["autonomy.stage.verify"],
    });
    const decision = evaluateAutonomyPolicy({
      action: "autonomy.stage.verify",
      executionClass: "reversible_write",
      config,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("explicitly denied");
  });

  it("resolves class override from config", () => {
    const config = createDefaultAutonomyPolicyConfig({
      actionClassOverrides: {
        "autonomy.stage.design": "reversible_write",
      },
    });
    const resolved = resolveAutonomyActionClass({
      action: "autonomy.stage.design",
      fallbackClass: "read_only",
      config,
    });
    expect(resolved).toBe("reversible_write");
  });
});
