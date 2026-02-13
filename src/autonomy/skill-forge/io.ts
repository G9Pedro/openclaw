import fs from "node:fs/promises";
import path from "node:path";

export function resolveAutonomyGeneratedSkillsDir(workspaceDir: string) {
  return path.join(workspaceDir, "skills", "autonomy-generated");
}

export function resolveAutonomySkillFilePath(params: { workspaceDir: string; skillName: string }) {
  const sanitized = params.skillName
    .toLowerCase()
    .replaceAll(/[^a-z0-9-_]+/g, "-")
    .replaceAll(/^-+|-+$/g, "");
  const fileName = `${sanitized || "autonomy-skill"}.md`;
  return path.join(resolveAutonomyGeneratedSkillsDir(params.workspaceDir), fileName);
}

export async function writeAutonomySkillFile(params: {
  workspaceDir: string;
  skillName: string;
  content: string;
}) {
  const filePath = resolveAutonomySkillFilePath({
    workspaceDir: params.workspaceDir,
    skillName: params.skillName,
  });
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, params.content, "utf-8");
  return filePath;
}

export async function readAutonomySkillFile(params: { workspaceDir: string; skillName: string }) {
  const filePath = resolveAutonomySkillFilePath({
    workspaceDir: params.workspaceDir,
    skillName: params.skillName,
  });
  const content = await fs.readFile(filePath, "utf-8");
  return { filePath, content };
}
