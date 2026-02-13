import { describe, expect, it } from "vitest";
import { upsertGapRegistry } from "./gap-registry.js";

describe("autonomy gap registry", () => {
  it("creates and ranks gaps deterministically", () => {
    const nowMs = 2_000_000;
    const gaps = upsertGapRegistry({
      gaps: [],
      signals: [
        {
          id: "a",
          key: "queue:overflow",
          title: "queue overflow",
          category: "reliability",
          severity: 80,
          confidence: 0.8,
          source: "manual",
          eventType: "autonomy.queue.overflow",
          ts: nowMs - 1_000,
          evidence: "overflow",
        },
        {
          id: "b",
          key: "task:stale",
          title: "stale task",
          category: "capability",
          severity: 65,
          confidence: 0.7,
          source: "manual",
          eventType: "autonomy.task.stale.blocked",
          ts: nowMs - 500,
          evidence: "stale",
        },
      ],
      nowMs,
    });
    expect(gaps).toHaveLength(2);
    expect(gaps[0]?.score).toBeGreaterThanOrEqual(gaps[1]?.score ?? 0);
  });

  it("increments occurrences for repeated signals", () => {
    const first = upsertGapRegistry({
      gaps: [],
      signals: [
        {
          id: "a",
          key: "same",
          title: "same gap",
          category: "quality",
          severity: 40,
          confidence: 0.5,
          source: "manual",
          eventType: "autonomy.review.daily",
          ts: 1_000,
          evidence: "first",
        },
      ],
      nowMs: 2_000,
    });
    const second = upsertGapRegistry({
      gaps: first,
      signals: [
        {
          id: "b",
          key: "same",
          title: "same gap",
          category: "quality",
          severity: 50,
          confidence: 0.6,
          source: "manual",
          eventType: "autonomy.review.daily",
          ts: 3_000,
          evidence: "second",
        },
      ],
      nowMs: 4_000,
    });
    expect(second).toHaveLength(1);
    expect(second[0]?.occurrences).toBe(2);
  });
});
