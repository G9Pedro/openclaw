import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveAutonomySkillFilePath } from "./io.js";
import { synthesizeSkillCandidates } from "./synthesizer.js";

describe("skill synthesizer", () => {
  let tmpDir = "";

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-skill-synth-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("writes generated skills and marks candidates planned", async () => {
    const result = await synthesizeSkillCandidates({
      workspaceDir: tmpDir,
      candidates: [
        {
          id: "c-1",
          sourceGapId: "g-1",
          name: "autonomy-test-skill",
          intent: "Test synthesis",
          status: "candidate",
          priority: 10,
          createdAt: 1_000,
          updatedAt: 1_000,
          safety: {
            executionClass: "reversible_write",
            constraints: ["must be safe"],
          },
          tests: ["unit test"],
        },
      ],
    });
    expect(result.synthesized).toBe(1);
    expect(result.candidates[0]?.status).toBe("planned");
    const filePath = resolveAutonomySkillFilePath({
      workspaceDir: tmpDir,
      skillName: "autonomy-test-skill",
    });
    const content = await fs.readFile(filePath, "utf-8");
    expect(content).toContain("## Safety constraints");
  });
});
