import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { AutonomyLedgerEntry } from "./types.js";
import { resolveAutonomyAgentDir } from "../store.js";

const LEDGER_FILENAME = "augmentation-ledger.jsonl";
const MAX_LEDGER_READ = 1000;
const writesByPath = new Map<string, Promise<void>>();

function withSerializedWrite(filePath: string, run: () => Promise<void>) {
  const resolved = path.resolve(filePath);
  const prev = writesByPath.get(resolved) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(run);
  writesByPath.set(resolved, next);
  return next;
}

export function resolveAutonomyLedgerPath(agentId: string) {
  return path.join(resolveAutonomyAgentDir(agentId), LEDGER_FILENAME);
}

export async function appendAutonomyLedgerEntry(
  input: Omit<AutonomyLedgerEntry, "id" | "ts" | "correlationId"> & {
    id?: string;
    ts?: number;
    correlationId?: string;
  },
) {
  const entry: AutonomyLedgerEntry = {
    id: input.id?.trim() || crypto.randomUUID(),
    ts: Number.isFinite(input.ts) ? Math.max(0, Math.floor(input.ts as number)) : Date.now(),
    correlationId: input.correlationId?.trim() || crypto.randomUUID(),
    ...input,
  };
  const ledgerPath = resolveAutonomyLedgerPath(entry.agentId);
  await withSerializedWrite(ledgerPath, async () => {
    await fs.mkdir(path.dirname(ledgerPath), { recursive: true });
    await fs.appendFile(ledgerPath, `${JSON.stringify(entry)}\n`, "utf-8");
  });
  return entry;
}

export async function readAutonomyLedgerEntries(params: {
  agentId: string;
  limit?: number;
  offset?: number;
}) {
  const ledgerPath = resolveAutonomyLedgerPath(params.agentId);
  const raw = await fs.readFile(ledgerPath, "utf-8").catch(() => "");
  if (!raw.trim()) {
    return [] as AutonomyLedgerEntry[];
  }
  const limit = Number.isFinite(params.limit)
    ? Math.max(0, Math.min(MAX_LEDGER_READ, Math.floor(params.limit as number)))
    : 100;
  const offset = Number.isFinite(params.offset)
    ? Math.max(0, Math.floor(params.offset as number))
    : 0;

  const lines = raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const parsed = lines
    .map((line) => {
      try {
        const value = JSON.parse(line) as AutonomyLedgerEntry;
        return value && typeof value === "object" ? value : null;
      } catch {
        return null;
      }
    })
    .filter((entry): entry is AutonomyLedgerEntry => entry !== null)
    .toSorted((a, b) => b.ts - a.ts);
  return parsed.slice(offset, offset + limit);
}
