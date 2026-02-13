import type { AutonomySkillCandidate } from "../types.js";
import { writeAutonomySkillFile } from "./io.js";

const MAX_SYNTHESIZED_PER_RUN = 3;

function buildSkillMarkdown(candidate: AutonomySkillCandidate) {
  return [
    "---",
    `name: ${candidate.name}`,
    "source: autonomy-generated",
    "---",
    "",
    `# ${candidate.name}`,
    "",
    "## Purpose",
    candidate.intent,
    "",
    "## Safety constraints",
    ...candidate.safety.constraints.map((constraint) => `- ${constraint}`),
    "",
    "## Verification checklist",
    ...candidate.tests.map((test) => `- ${test}`),
    "",
    "## Operational guidance",
    "- Prefer deterministic, reversible steps.",
    "- Record evidence for every completed action.",
    "",
  ].join("\n");
}

export async function synthesizeSkillCandidates(params: {
  workspaceDir: string;
  candidates: AutonomySkillCandidate[];
}) {
  const updatedCandidates = [...params.candidates];
  let synthesized = 0;
  for (let index = 0; index < updatedCandidates.length; index += 1) {
    if (synthesized >= MAX_SYNTHESIZED_PER_RUN) {
      break;
    }
    const candidate = updatedCandidates[index];
    if (!candidate || (candidate.status !== "candidate" && candidate.status !== "planned")) {
      continue;
    }
    const content = buildSkillMarkdown(candidate);
    await writeAutonomySkillFile({
      workspaceDir: params.workspaceDir,
      skillName: candidate.name,
      content,
    });
    updatedCandidates[index] = {
      ...candidate,
      status: "planned",
      updatedAt: Date.now(),
    };
    synthesized += 1;
  }

  return {
    candidates: updatedCandidates,
    synthesized,
  };
}
