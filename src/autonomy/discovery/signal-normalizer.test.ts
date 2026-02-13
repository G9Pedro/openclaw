import { describe, expect, it } from "vitest";
import { normalizeAutonomySignals } from "./signal-normalizer.js";

describe("autonomy signal normalizer", () => {
  it("classifies queue and stale task events", () => {
    const signals = normalizeAutonomySignals([
      {
        id: "1",
        source: "manual",
        type: "autonomy.queue.overflow",
        ts: 1_000,
      },
      {
        id: "2",
        source: "manual",
        type: "autonomy.task.stale.blocked",
        ts: 2_000,
      },
    ]);
    expect(signals).toHaveLength(2);
    expect(signals[0]?.category).toBe("reliability");
    expect(signals[1]?.category).toBe("capability");
  });

  it("dedupes by dedupe key", () => {
    const signals = normalizeAutonomySignals([
      {
        id: "1",
        source: "manual",
        type: "work.error",
        ts: 1_000,
        dedupeKey: "same",
      },
      {
        id: "2",
        source: "manual",
        type: "work.error",
        ts: 1_200,
        dedupeKey: "same",
      },
    ]);
    expect(signals).toHaveLength(1);
  });
});
