import type { AutonomySkillCandidate } from "../types.js";
import { readAutonomySkillFile } from "./io.js";

export type SkillVerificationReport = {
  candidateId: string;
  skillName: string;
  ok: boolean;
  failures: string[];
};

const MAX_VERIFIED_PER_RUN = 5;

function verifySkillContent(params: {
  skillName: string;
  content: string;
  candidate: AutonomySkillCandidate;
}): SkillVerificationReport {
  const failures: string[] = [];
  if (!params.content.includes("## Purpose")) {
    failures.push("missing purpose section");
  }
  if (!params.content.includes("## Safety constraints")) {
    failures.push("missing safety constraints section");
  }
  if (!params.content.includes("## Verification checklist")) {
    failures.push("missing verification checklist section");
  }
  for (const requiredConstraint of params.candidate.safety.constraints) {
    if (!params.content.includes(requiredConstraint)) {
      failures.push(`missing constraint: ${requiredConstraint}`);
    }
  }
  for (const requiredTest of params.candidate.tests) {
    if (!params.content.includes(requiredTest)) {
      failures.push(`missing test: ${requiredTest}`);
    }
  }
  return {
    candidateId: params.candidate.id,
    skillName: params.skillName,
    ok: failures.length === 0,
    failures,
  };
}

export async function verifySkillCandidates(params: {
  workspaceDir: string;
  candidates: AutonomySkillCandidate[];
}) {
  const updatedCandidates = [...params.candidates];
  const reports: SkillVerificationReport[] = [];
  let checked = 0;
  for (let index = 0; index < updatedCandidates.length; index += 1) {
    if (checked >= MAX_VERIFIED_PER_RUN) {
      break;
    }
    const candidate = updatedCandidates[index];
    if (!candidate || candidate.status !== "planned") {
      continue;
    }
    checked += 1;
    let content = "";
    try {
      const loaded = await readAutonomySkillFile({
        workspaceDir: params.workspaceDir,
        skillName: candidate.name,
      });
      content = loaded.content;
    } catch {
      reports.push({
        candidateId: candidate.id,
        skillName: candidate.name,
        ok: false,
        failures: ["generated skill file is missing"],
      });
      updatedCandidates[index] = {
        ...candidate,
        status: "rejected",
        updatedAt: Date.now(),
      };
      continue;
    }

    const report = verifySkillContent({
      skillName: candidate.name,
      content,
      candidate,
    });
    reports.push(report);
    updatedCandidates[index] = {
      ...candidate,
      status: report.ok ? "verified" : "rejected",
      updatedAt: Date.now(),
    };
  }

  return {
    candidates: updatedCandidates,
    reports,
  };
}
