import { describe, expect, it } from "vitest";
import { planSkillCandidates } from "./planner.js";

describe("skill planner", () => {
  it("generates candidates for open gaps", () => {
    const planned = planSkillCandidates({
      nowMs: 1_000_000,
      gaps: [
        {
          id: "gap-1",
          key: "queue:overflow",
          title: "Queue overflow",
          category: "reliability",
          status: "open",
          severity: 90,
          confidence: 0.9,
          score: 90,
          occurrences: 2,
          firstSeenAt: 500_000,
          lastSeenAt: 900_000,
          lastSource: "manual",
          evidence: ["e1"],
        },
      ],
      existingCandidates: [],
    });
    expect(planned.generatedCount).toBe(1);
    expect(planned.candidates[0]?.sourceGapId).toBe("gap-1");
  });

  it("does not duplicate candidates for same gap", () => {
    const existing = [
      {
        id: "skill-gap-1",
        sourceGapId: "gap-1",
        name: "autonomy-gap-1",
        intent: "fix",
        status: "candidate" as const,
        priority: 10,
        createdAt: 1_000,
        updatedAt: 1_000,
        safety: {
          executionClass: "reversible_write" as const,
          constraints: ["safe"],
        },
        tests: ["unit"],
      },
    ];
    const planned = planSkillCandidates({
      nowMs: 2_000,
      gaps: [
        {
          id: "gap-1",
          key: "same",
          title: "same",
          category: "quality",
          status: "open",
          severity: 50,
          confidence: 0.5,
          score: 50,
          occurrences: 1,
          firstSeenAt: 1_000,
          lastSeenAt: 1_500,
          lastSource: "manual",
          evidence: [],
        },
      ],
      existingCandidates: existing,
    });
    expect(planned.generatedCount).toBe(0);
    expect(planned.candidates).toHaveLength(1);
  });
});
