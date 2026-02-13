import { describe, expect, it } from "vitest";
import { ensureProposalPathAllowlist, validateCodePatchProposal } from "./patch-contract.js";

describe("code forge patch contract", () => {
  it("requires rollback metadata", () => {
    const validation = validateCodePatchProposal({
      id: "p-1",
      title: "test",
      summary: "summary",
      files: ["src/autonomy/runtime.ts"],
      risk: "medium",
      rollback: {
        strategy: "git_revert",
        reference: "",
      },
      tests: ["pnpm test"],
    });
    expect(validation.ok).toBe(false);
  });

  it("enforces file allowlist", () => {
    const result = ensureProposalPathAllowlist({
      proposal: {
        id: "p-1",
        title: "test",
        summary: "summary",
        files: ["src/autonomy/runtime.ts", "docs/testing.md"],
        risk: "medium",
        rollback: {
          strategy: "git_revert",
          reference: "abc123",
        },
        tests: ["pnpm test"],
      },
      allowlistPrefixes: ["src/autonomy"],
    });
    expect(result.ok).toBe(false);
    expect(result.deniedFiles).toEqual(["docs/testing.md"]);
  });
});
