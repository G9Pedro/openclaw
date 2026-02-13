import crypto from "node:crypto";
import type {
  AutonomyAugmentationGapCategory,
  AutonomyEvent,
  AutonomyEventSource,
} from "../types.js";

export type AutonomyDiscoverySignal = {
  id: string;
  key: string;
  title: string;
  category: AutonomyAugmentationGapCategory;
  severity: number;
  confidence: number;
  source: AutonomyEventSource;
  eventType: string;
  ts: number;
  evidence: string;
};

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function classifySignal(eventType: string): {
  category: AutonomyAugmentationGapCategory;
  severity: number;
  confidence: number;
} {
  const lowered = eventType.toLowerCase();
  if (lowered.startsWith("autonomy.queue.")) {
    return { category: "reliability", severity: 85, confidence: 0.9 };
  }
  if (lowered.startsWith("autonomy.task.stale.")) {
    return { category: "capability", severity: 70, confidence: 0.85 };
  }
  if (lowered.startsWith("autonomy.review.")) {
    return { category: "quality", severity: 40, confidence: 0.6 };
  }
  if (lowered.includes("security") || lowered.includes("policy")) {
    return { category: "safety", severity: 90, confidence: 0.8 };
  }
  if (lowered.includes("timeout") || lowered.includes("error") || lowered.includes("failed")) {
    return { category: "reliability", severity: 75, confidence: 0.8 };
  }
  if (lowered.includes("latency")) {
    return { category: "latency", severity: 65, confidence: 0.65 };
  }
  if (lowered.includes("cost") || lowered.includes("budget")) {
    return { category: "cost", severity: 55, confidence: 0.7 };
  }
  return { category: "unknown", severity: 30, confidence: 0.4 };
}

function buildSignalTitle(event: AutonomyEvent) {
  const payloadTitle =
    typeof event.payload?.title === "string" && event.payload.title.trim()
      ? event.payload.title.trim()
      : undefined;
  if (payloadTitle) {
    return payloadTitle;
  }
  return event.type.replaceAll(".", " ");
}

function buildEvidence(event: AutonomyEvent) {
  const pieces = [`source=${event.source}`, `type=${event.type}`];
  if (event.dedupeKey) {
    pieces.push(`dedupeKey=${event.dedupeKey}`);
  }
  return pieces.join(" ");
}

export function normalizeAutonomySignals(events: AutonomyEvent[]): AutonomyDiscoverySignal[] {
  const dedupe = new Set<string>();
  const signals: AutonomyDiscoverySignal[] = [];
  for (const event of events) {
    const key = event.dedupeKey?.trim() || `${event.source}:${event.type}`;
    if (dedupe.has(key)) {
      continue;
    }
    dedupe.add(key);
    const classification = classifySignal(event.type);
    signals.push({
      id: crypto.createHash("sha1").update(key).digest("hex").slice(0, 16),
      key,
      title: buildSignalTitle(event),
      category: classification.category,
      severity: clamp(Math.floor(classification.severity), 0, 100),
      confidence: clamp(classification.confidence, 0, 1),
      source: event.source,
      eventType: event.type,
      ts: event.ts,
      evidence: buildEvidence(event),
    });
  }
  return signals;
}
