import { runCommandWithTimeout } from "../../process/exec.js";

export type VerificationCommand = {
  name: string;
  argv: string[];
  timeoutMs?: number;
};

export type VerificationCommandResult = {
  name: string;
  argv: string[];
  code: number | null;
  signal: NodeJS.Signals | null;
  killed: boolean;
  stdout: string;
  stderr: string;
  ok: boolean;
};

export async function runVerificationCommands(params: {
  workspaceDir: string;
  commands: VerificationCommand[];
  defaultTimeoutMs?: number;
}) {
  const defaultTimeoutMs = Number.isFinite(params.defaultTimeoutMs)
    ? Math.max(1_000, Math.floor(params.defaultTimeoutMs as number))
    : 120_000;
  const results: VerificationCommandResult[] = [];
  for (const command of params.commands) {
    if (!Array.isArray(command.argv) || command.argv.length === 0) {
      results.push({
        name: command.name,
        argv: command.argv,
        code: null,
        signal: null,
        killed: false,
        stdout: "",
        stderr: "invalid command argv",
        ok: false,
      });
      continue;
    }
    const timeoutMs = Number.isFinite(command.timeoutMs)
      ? Math.max(1_000, Math.floor(command.timeoutMs as number))
      : defaultTimeoutMs;
    const result = await runCommandWithTimeout(command.argv, {
      cwd: params.workspaceDir,
      timeoutMs,
    });
    const ok = result.code === 0 && !result.killed;
    results.push({
      name: command.name,
      argv: command.argv,
      code: result.code,
      signal: result.signal,
      killed: result.killed,
      stdout: result.stdout,
      stderr: result.stderr,
      ok,
    });
    if (!ok) {
      break;
    }
  }
  return {
    ok: results.every((result) => result.ok),
    results,
  };
}
