import { describe, expect, it } from "vitest";
import { runVerificationCommands } from "./verify-runner.js";

describe("code forge verify runner", () => {
  it("runs commands and stops on first failure", async () => {
    const result = await runVerificationCommands({
      workspaceDir: process.cwd(),
      commands: [
        {
          name: "ok",
          argv: ["node", "-e", "process.exit(0)"],
        },
        {
          name: "fail",
          argv: ["node", "-e", "process.exit(2)"],
        },
        {
          name: "not-run",
          argv: ["node", "-e", "process.exit(0)"],
        },
      ],
      defaultTimeoutMs: 10_000,
    });
    expect(result.ok).toBe(false);
    expect(result.results).toHaveLength(2);
    expect(result.results[1]?.code).toBe(2);
  });
});
