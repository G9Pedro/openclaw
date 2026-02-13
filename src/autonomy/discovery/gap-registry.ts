import crypto from "node:crypto";
import type { AutonomyAugmentationGap } from "../types.js";
import type { AutonomyDiscoverySignal } from "./signal-normalizer.js";

const MAX_GAPS = 200;

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function computeGapScore(gap: AutonomyAugmentationGap, nowMs: number) {
  const severityComponent = gap.severity * 0.55;
  const confidenceComponent = gap.confidence * 100 * 0.25;
  const freshnessHours = Math.max(0, (nowMs - gap.lastSeenAt) / 3_600_000);
  const freshnessComponent = clamp(24 - freshnessHours, 0, 24) * 0.2;
  const occurrenceComponent = Math.min(20, gap.occurrences) * 0.5;
  return Math.round(
    severityComponent + confidenceComponent + freshnessComponent + occurrenceComponent,
  );
}

function createGapFromSignal(signal: AutonomyDiscoverySignal): AutonomyAugmentationGap {
  const ts = Math.floor(signal.ts);
  return {
    id: crypto.createHash("sha1").update(`gap:${signal.key}`).digest("hex").slice(0, 16),
    key: signal.key,
    title: signal.title,
    category: signal.category,
    status: "open",
    severity: signal.severity,
    confidence: signal.confidence,
    score: 0,
    occurrences: 1,
    firstSeenAt: ts,
    lastSeenAt: ts,
    lastSource: signal.source,
    evidence: [signal.evidence].slice(-10),
  };
}

export function upsertGapRegistry(params: {
  gaps: AutonomyAugmentationGap[];
  signals: AutonomyDiscoverySignal[];
  nowMs: number;
}) {
  const byKey = new Map<string, AutonomyAugmentationGap>();
  for (const gap of params.gaps) {
    byKey.set(gap.key, { ...gap, evidence: [...gap.evidence].slice(-10) });
  }

  for (const signal of params.signals) {
    const existing = byKey.get(signal.key);
    if (!existing) {
      byKey.set(signal.key, createGapFromSignal(signal));
      continue;
    }
    existing.title = signal.title;
    existing.category = signal.category;
    existing.occurrences += 1;
    existing.lastSeenAt = Math.max(existing.lastSeenAt, Math.floor(signal.ts));
    existing.lastSource = signal.source;
    existing.severity = clamp(
      Math.round((existing.severity * 0.65 + signal.severity * 0.35) * 100) / 100,
      0,
      100,
    );
    existing.confidence = clamp(existing.confidence * 0.7 + signal.confidence * 0.3, 0, 1);
    existing.evidence = [...existing.evidence, signal.evidence].slice(-10);
  }

  const ranked = [...byKey.values()]
    .map((gap) => ({
      ...gap,
      score: computeGapScore(gap, params.nowMs),
    }))
    .toSorted(
      (a, b) => b.score - a.score || b.lastSeenAt - a.lastSeenAt || a.key.localeCompare(b.key),
    )
    .slice(0, MAX_GAPS);

  return ranked;
}
