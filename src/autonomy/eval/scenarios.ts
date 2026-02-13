export type AutonomyEvalScenarioKind = "baseline" | "adversarial" | "regression";

export type AutonomyEvalScenarioStep = {
  type: string;
  expected: "improve" | "degrade" | "neutral";
  weight: number;
};

export type AutonomyEvalScenario = {
  id: string;
  kind: AutonomyEvalScenarioKind;
  description: string;
  steps: AutonomyEvalScenarioStep[];
};

export function getDefaultAutonomyEvalScenarios(): AutonomyEvalScenario[] {
  return [
    {
      id: "baseline-productivity",
      kind: "baseline",
      description: "Balanced signal mix should keep autonomy stable and productive",
      steps: [
        { type: "autonomy.review.daily", expected: "improve", weight: 1.0 },
        { type: "autonomy.review.weekly", expected: "improve", weight: 1.2 },
        { type: "autonomy.task.stale.blocked", expected: "degrade", weight: 0.8 },
      ],
    },
    {
      id: "adversarial-error-burst",
      kind: "adversarial",
      description: "Error bursts should not collapse score below floor with verified candidates",
      steps: [
        { type: "autonomy.queue.invalid", expected: "degrade", weight: 1.3 },
        { type: "autonomy.queue.overflow", expected: "degrade", weight: 1.1 },
        { type: "autonomy.augmentation.canary.evaluated", expected: "neutral", weight: 0.8 },
      ],
    },
    {
      id: "regression-promotion-readiness",
      kind: "regression",
      description: "Promotion readiness should improve when verified candidates exist",
      steps: [
        { type: "autonomy.augmentation.candidates.updated", expected: "improve", weight: 1.4 },
        { type: "autonomy.augmentation.phase.enter", expected: "neutral", weight: 0.7 },
        { type: "autonomy.augmentation.policy.denied", expected: "degrade", weight: 1.0 },
      ],
    },
  ];
}
