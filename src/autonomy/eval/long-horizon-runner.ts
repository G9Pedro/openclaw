import type { AutonomyState } from "../types.js";
import { getDefaultAutonomyEvalScenarios, type AutonomyEvalScenario } from "./scenarios.js";

export type LongHorizonScenarioResult = {
  id: string;
  kind: string;
  score: number;
};

export type LongHorizonEvalReport = {
  scenarioCount: number;
  score: number;
  results: LongHorizonScenarioResult[];
};

function clampScore(value: number) {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}

function evaluateScenario(params: {
  scenario: AutonomyEvalScenario;
  verifiedCandidateCount: number;
  recentErrorRate: number;
  blockedTaskCount: number;
}) {
  const candidateBoost = Math.min(0.25, params.verifiedCandidateCount * 0.06);
  const errorPenalty = Math.min(0.35, params.recentErrorRate * 0.7);
  const blockedPenalty = Math.min(0.2, params.blockedTaskCount * 0.02);
  let score = clampScore(0.65 + candidateBoost - errorPenalty - blockedPenalty);

  for (const step of params.scenario.steps) {
    const weight = Math.max(0, step.weight);
    if (step.expected === "improve") {
      score += 0.03 * weight;
    } else if (step.expected === "degrade") {
      score -= 0.03 * weight;
    } else {
      score += 0.005 * weight;
    }
  }
  return clampScore(score);
}

export function runLongHorizonScenarioPack(params: {
  state: Pick<AutonomyState, "augmentation" | "recentCycles" | "tasks">;
  scenarios?: AutonomyEvalScenario[];
}): LongHorizonEvalReport {
  const scenarios = params.scenarios ?? getDefaultAutonomyEvalScenarios();
  if (scenarios.length === 0) {
    return {
      scenarioCount: 0,
      score: 0,
      results: [],
    };
  }
  const actionableCycles = params.state.recentCycles.filter((cycle) => cycle.status !== "skipped");
  const recentErrorRate =
    actionableCycles.length > 0
      ? actionableCycles.filter((cycle) => cycle.status === "error").length /
        actionableCycles.length
      : 0;
  const verifiedCandidateCount = params.state.augmentation.candidates.filter(
    (candidate) => candidate.status === "verified",
  ).length;
  const blockedTaskCount = params.state.tasks.filter((task) => task.status === "blocked").length;

  const results = scenarios.map((scenario) => ({
    id: scenario.id,
    kind: scenario.kind,
    score: evaluateScenario({
      scenario,
      verifiedCandidateCount,
      recentErrorRate,
      blockedTaskCount,
    }),
  }));
  const score = clampScore(results.reduce((sum, result) => sum + result.score, 0) / results.length);
  return {
    scenarioCount: scenarios.length,
    score,
    results,
  };
}
