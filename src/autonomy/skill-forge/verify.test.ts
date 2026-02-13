import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeAutonomySkillFile } from "./io.js";
import { verifySkillCandidates } from "./verify.js";

describe("skill verifier", () => {
  let tmpDir = "";

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-skill-verify-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("marks candidates verified when generated skill is valid", async () => {
    await writeAutonomySkillFile({
      workspaceDir: tmpDir,
      skillName: "autonomy-verified",
      content: [
        "## Purpose",
        "x",
        "## Safety constraints",
        "- must be reversible",
        "## Verification checklist",
        "- unit test",
      ].join("\n"),
    });
    const result = await verifySkillCandidates({
      workspaceDir: tmpDir,
      candidates: [
        {
          id: "c-1",
          sourceGapId: "g-1",
          name: "autonomy-verified",
          intent: "verify",
          status: "planned",
          priority: 1,
          createdAt: 1_000,
          updatedAt: 1_000,
          safety: {
            executionClass: "reversible_write",
            constraints: ["must be reversible"],
          },
          tests: ["unit test"],
        },
      ],
    });
    expect(result.reports[0]?.ok).toBe(true);
    expect(result.candidates[0]?.status).toBe("verified");
  });

  it("rejects candidates with missing generated files", async () => {
    const result = await verifySkillCandidates({
      workspaceDir: tmpDir,
      candidates: [
        {
          id: "c-1",
          sourceGapId: "g-1",
          name: "autonomy-missing",
          intent: "verify",
          status: "planned",
          priority: 1,
          createdAt: 1_000,
          updatedAt: 1_000,
          safety: {
            executionClass: "reversible_write",
            constraints: ["must be reversible"],
          },
          tests: ["unit test"],
        },
      ],
    });
    expect(result.reports[0]?.ok).toBe(false);
    expect(result.candidates[0]?.status).toBe("rejected");
  });
});
