import { describe, expect, it } from "vitest";
import type { AutonomyState } from "../types.js";
import { runLongHorizonScenarioPack } from "./long-horizon-runner.js";

describe("long horizon runner", () => {
  it("produces deterministic score for same input state", () => {
    const state: Pick<AutonomyState, "augmentation" | "recentCycles" | "tasks"> = {
      augmentation: {
        stage: "discover",
        stageEnteredAt: 1_000,
        lastTransitionAt: 1_000,
        phaseRunCount: 1,
        policyVersion: "2026-02-13",
        gaps: [],
        candidates: [
          {
            id: "v-1",
            sourceGapId: "g-1",
            name: "verified",
            intent: "verified candidate",
            priority: 1,
            createdAt: 1,
            updatedAt: 1,
            safety: {
              executionClass: "reversible_write",
              constraints: ["safe"],
            },
            tests: ["unit"],
            status: "verified",
          },
          {
            id: "c-1",
            sourceGapId: "g-2",
            name: "candidate",
            intent: "candidate",
            priority: 1,
            createdAt: 1,
            updatedAt: 1,
            safety: {
              executionClass: "reversible_write",
              constraints: ["safe"],
            },
            tests: ["unit"],
            status: "candidate",
          },
        ],
        activeExperiments: [],
        transitions: [],
      },
      recentCycles: [
        { ts: 1, status: "ok", processedEvents: 1, durationMs: 10 },
        { ts: 2, status: "ok", processedEvents: 1, durationMs: 10 },
        { ts: 3, status: "error", processedEvents: 1, durationMs: 10 },
      ],
      tasks: [
        {
          id: "t-1",
          title: "blocked",
          status: "blocked",
          priority: "high",
          dependencies: [],
          owner: "autonomy",
          createdAt: 1,
          updatedAt: 1,
        },
        {
          id: "t-2",
          title: "pending",
          status: "pending",
          priority: "medium",
          dependencies: [],
          owner: "autonomy",
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    };

    const first = runLongHorizonScenarioPack({
      state,
    });
    const second = runLongHorizonScenarioPack({
      state,
    });
    expect(first.score).toBe(second.score);
    expect(first.results).toEqual(second.results);
  });
});
