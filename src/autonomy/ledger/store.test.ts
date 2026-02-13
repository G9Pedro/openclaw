import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("autonomy ledger store", () => {
  let tmpDir = "";
  let priorStateDir: string | undefined;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-autonomy-ledger-"));
    priorStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = tmpDir;
    vi.resetModules();
  });

  afterEach(async () => {
    if (priorStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = priorStateDir;
    }
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("appends and reads ledger entries", async () => {
    const ledger = await import("./store.js");
    await ledger.appendAutonomyLedgerEntry({
      agentId: "ops",
      eventType: "phase_enter",
      stage: "discover",
      actor: "phase-machine",
      summary: "entered discover",
    });
    await ledger.appendAutonomyLedgerEntry({
      agentId: "ops",
      eventType: "candidate_update",
      stage: "design",
      actor: "skill-planner",
      summary: "generated candidates",
    });
    const entries = await ledger.readAutonomyLedgerEntries({ agentId: "ops", limit: 10 });
    expect(entries).toHaveLength(2);
    expect(entries[0]?.ts).toBeGreaterThanOrEqual(entries[1]?.ts ?? 0);
  });

  it("returns empty list for missing ledger file", async () => {
    const ledger = await import("./store.js");
    const entries = await ledger.readAutonomyLedgerEntries({ agentId: "missing" });
    expect(entries).toEqual([]);
  });
});
