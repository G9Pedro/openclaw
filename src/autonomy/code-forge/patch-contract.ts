export type CodePatchRollbackPlan = {
  strategy: "git_revert" | "apply_inverse_patch" | "restore_snapshot";
  reference: string;
};

export type CodePatchProposal = {
  id: string;
  title: string;
  summary: string;
  files: string[];
  risk: "low" | "medium" | "high";
  rollback: CodePatchRollbackPlan;
  tests: string[];
};

export function validateCodePatchProposal(
  proposal: CodePatchProposal,
): { ok: true } | { ok: false; error: string } {
  if (!proposal.id.trim()) {
    return { ok: false, error: "proposal id is required" };
  }
  if (!proposal.title.trim()) {
    return { ok: false, error: "proposal title is required" };
  }
  if (!proposal.summary.trim()) {
    return { ok: false, error: "proposal summary is required" };
  }
  if (!Array.isArray(proposal.files) || proposal.files.length === 0) {
    return { ok: false, error: "proposal files are required" };
  }
  if (proposal.files.some((file) => !file.trim())) {
    return { ok: false, error: "proposal files must not contain empty paths" };
  }
  if (proposal.risk !== "low" && proposal.risk !== "medium" && proposal.risk !== "high") {
    return { ok: false, error: "proposal risk is invalid" };
  }
  if (!proposal.rollback.reference.trim()) {
    return { ok: false, error: "rollback reference is required" };
  }
  if (!Array.isArray(proposal.tests) || proposal.tests.length === 0) {
    return { ok: false, error: "proposal tests are required" };
  }
  return { ok: true };
}

export function ensureProposalPathAllowlist(params: {
  proposal: CodePatchProposal;
  allowlistPrefixes: string[];
}) {
  const prefixes = params.allowlistPrefixes.map((prefix) => prefix.trim()).filter(Boolean);
  if (prefixes.length === 0) {
    return { ok: false as const, deniedFiles: params.proposal.files };
  }
  const deniedFiles = params.proposal.files.filter(
    (file) => !prefixes.some((prefix) => file === prefix || file.startsWith(`${prefix}/`)),
  );
  return deniedFiles.length > 0
    ? { ok: false as const, deniedFiles }
    : { ok: true as const, deniedFiles: [] as string[] };
}
