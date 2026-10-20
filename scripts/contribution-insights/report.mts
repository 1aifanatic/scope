// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Contribution, InsightsContext } from "./collect.mjs";

export const SCENARIOS = [
  "value-fit",
  "overlap",
  "readiness",
  "behavioral-evidence",
  "scope-completeness",
  "reviewer-routing",
] as const;

interface Rating {
  score: number | null;
  rationale: string;
  evidence: string[];
}

export interface ContributionAssessment {
  number: number;
  headSha: string;
  value: Rating;
  correctnessEvidence: Rating;
  readiness: "blocked" | "needs-clarification" | "ready-for-review";
  risk: "low" | "medium" | "high";
  confidence: "low" | "medium" | "high";
  recommendation: "prioritize-review" | "request-clarification" | "request-contributor-changes" | "maintainer-scope-decision";
  scenarios: Array<{
    id: (typeof SCENARIOS)[number];
    assessment: "clear" | "needs-attention" | "unassessed";
    summary: string;
    evidence: string[];
  }>;
  reviewerBrief: { summary: string; reviewOrder: string[]; suggestedOwners: string[]; requiredApprovals: 1 | 2 };
  feedback: { required: string[]; optional: string[]; maintainerDecision: string[] };
  limitations: string[];
}

export interface ContributionReport {
  schemaVersion: 1;
  assessments: ContributionAssessment[];
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 4_000) {
    throw new Error(`${label} must be a nonempty string of at most 4000 characters`);
  }
  if (/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|Bearer\s+(?!\[REDACTED_TOKEN\])[A-Za-z0-9._~+/=-]+)\b/i.test(value)) {
    throw new Error(`${label} contains a possible credential`);
  }
  if (/https?:\/\/|<[^>]*>/i.test(value)) throw new Error(`${label} must use evidence IDs instead of URLs or HTML`);
  return value;
}

function strings(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > 20) throw new Error(`${label} must be an array of at most 20 strings`);
  return value.map((item) => string(item, label));
}

function oneOf<const T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  const match = allowed.find((candidate) => candidate === value);
  if (match === undefined) throw new Error(`${label} must be one of ${allowed.join(", ")}`);
  return match;
}

export function evidenceLinks(context: InsightsContext, contribution: Contribution): Map<string, string> {
  const links = new Map<string, string>([[`pr:${contribution.number}`, contribution.url]]);
  for (const file of contribution.files) {
    const revision = file.status === "removed" ? contribution.baseSha : contribution.headSha;
    links.set(`file:${file.path}`, `https://github.com/${context.repository}/blob/${revision}/${file.path.split("/").map(encodeURIComponent).join("/")}`);
  }
  for (const item of [...contribution.checks, ...contribution.comments]) links.set(item.evidenceId, item.url);
  for (const item of contribution.related) links.set(`related:${item.number}`, item.url);
  for (const policy of context.policies) {
    links.set(`policy:${policy.path}`, context.policySource === "working-tree" ? "context.json" :
      `https://github.com/${context.repository}/blob/${context.trustedRevision}/${policy.path}`);
  }
  return links;
}

export function parseReport(raw: string, context: InsightsContext): ContributionReport {
  if (raw.length > 120_000) throw new Error("Contribution report exceeds 120000 characters");
  const root = object(JSON.parse(raw) as unknown, "report");
  if (root.schemaVersion !== 1 || !Array.isArray(root.assessments) ||
    root.assessments.length !== context.contributions.length) {
    throw new Error("Report must have schemaVersion 1 and exactly one assessment for every captured contribution");
  }
  const seen = new Set<number>();
  const assessments = root.assessments.map((value): ContributionAssessment => {
    const item = object(value, "assessment");
    const contribution = context.contributions.find((candidate) => candidate.number === item.number);
    if (!contribution || seen.has(contribution.number) || item.headSha !== contribution.headSha) {
      throw new Error("Assessment has a duplicate, unknown PR number, or stale head SHA");
    }
    seen.add(contribution.number);
    const links = evidenceLinks(context, contribution);
    const evidence = (value: unknown): string[] => {
      const ids = strings(value, "evidence");
      if (ids.some((id) => !links.has(id))) throw new Error("Assessment cites evidence absent from its captured PR snapshot");
      return ids;
    };
    const rating = (value: unknown, label: string): Rating => {
      const entry = object(value, label);
      if (entry.score !== null && (typeof entry.score !== "number" || !Number.isInteger(entry.score) || entry.score < 1 || entry.score > 5)) {
        throw new Error(`${label}.score must be null or an integer from 1 to 5`);
      }
      const ids = evidence(entry.evidence);
      if (entry.score !== null && !ids.length) throw new Error(`${label} needs evidence for a numeric score`);
      return { score: entry.score, rationale: string(entry.rationale, `${label}.rationale`), evidence: ids };
    };
    if (!Array.isArray(item.scenarios) || item.scenarios.length !== SCENARIOS.length) {
      throw new Error("Every assessment must cover all six P0 scenarios");
    }
    const scenarioIds = new Set<string>();
    const scenarios = item.scenarios.map((value): ContributionAssessment["scenarios"][number] => {
      const scenario = object(value, "scenario");
      const id = oneOf(scenario.id, SCENARIOS, "scenario ID");
      if (scenarioIds.has(id)) throw new Error("Duplicate scenario ID");
      scenarioIds.add(id);
      const assessment = oneOf(scenario.assessment, ["clear", "needs-attention", "unassessed"], "scenario assessment");
      const ids = evidence(scenario.evidence);
      if (assessment !== "unassessed" && !ids.length) throw new Error("Assessed scenarios require evidence");
      return { id, assessment, summary: string(scenario.summary, "scenario summary"), evidence: ids };
    });
    const brief = object(item.reviewerBrief, "reviewer brief");
    if ((brief.requiredApprovals !== 1 && brief.requiredApprovals !== 2) ||
      brief.requiredApprovals < contribution.minimumApprovals) {
      throw new Error("Reviewer brief understates the repository approval policy");
    }
    const owners = new Set(context.policies.find((policy) => policy.path === ".github/CODEOWNERS")?.content.match(/@[A-Za-z0-9_/-]+/g) ?? []);
    const suggestedOwners = strings(brief.suggestedOwners, "suggested owners");
    if (suggestedOwners.some((owner) => !owners.has(owner))) throw new Error("Suggested reviewer is absent from trusted CODEOWNERS");
    const confidence = oneOf(item.confidence, ["low", "medium", "high"], "confidence");
    if (confidence === "high" && contribution.limitations.length) {
      throw new Error("High confidence is not allowed with incomplete captured evidence");
    }
    const risk = oneOf(item.risk, ["low", "medium", "high"], "risk");
    if (risk === "low" && brief.requiredApprovals === 2) throw new Error("Sensitive changes cannot be rated low risk");
    const feedback = object(item.feedback, "feedback");
    return {
      number: contribution.number, headSha: contribution.headSha,
      value: rating(item.value, "value"), correctnessEvidence: rating(item.correctnessEvidence, "correctness evidence"),
      readiness: oneOf(item.readiness, ["blocked", "needs-clarification", "ready-for-review"], "readiness"),
      risk, confidence,
      recommendation: oneOf(item.recommendation, [
        "prioritize-review", "request-clarification", "request-contributor-changes", "maintainer-scope-decision",
      ], "recommendation"),
      scenarios,
      reviewerBrief: {
        summary: string(brief.summary, "reviewer summary"), reviewOrder: strings(brief.reviewOrder, "review order"),
        suggestedOwners, requiredApprovals: brief.requiredApprovals,
      },
      feedback: {
        required: strings(feedback.required, "required feedback"), optional: strings(feedback.optional, "optional feedback"),
        maintainerDecision: strings(feedback.maintainerDecision, "maintainer decisions"),
      },
      limitations: strings(item.limitations, "limitations"),
    };
  });
  return { schemaVersion: 1, assessments };
}

function escape(value: string): string {
  return value.replace(/[\\`*_[\]<>|#]/g, "\\$&").replace(/\r?\n/g, " ");
}

function list(values: string[]): string {
  return values.length ? values.map((value) => `- ${escape(value)}`).join("\n") : "None identified.";
}

export function renderReport(report: ContributionReport, context: InsightsContext): string {
  const sections = [
    "# Contribution Insights",
    "",
    "**Report-only pilot. AI-generated advice, not approval or a merge recommendation. Contributor feedback below is a draft and was not posted.**",
    "",
    context.policySource === "working-tree"
      ? `Collected: ${context.collectedAt}. Local working-tree policies are captured in context.json; checkout base: \`${context.trustedRevision}\`.`
      : `Collected: ${context.collectedAt}. Trusted policy revision: \`${context.trustedRevision}\`.`,
    "",
    `Considered ${context.selection.considered} PRs; captured ${context.selection.selected}.`,
    list(context.selection.limitations),
  ];
  if (!report.assessments.length) sections.push("", "No eligible community contributions were selected.");
  for (const assessment of report.assessments) {
    const contribution = context.contributions.find((candidate) => candidate.number === assessment.number);
    if (!contribution) throw new Error("Cannot render an assessment without its snapshot");
    const links = evidenceLinks(context, contribution);
    const citations = (ids: string[]): string => ids.map((id) => `[${escape(id)}](${links.get(id)})`).join(", ") || "Unassessed";
    sections.push(
      "", `## [PR #${contribution.number}](${contribution.url}): ${escape(contribution.title)}`,
      "", `Head: \`${contribution.headSha}\`. Base: \`${contribution.baseSha}\`. Draft: ${contribution.draft}.`,
      "", "### Scorecard",
      "", "| Dimension | Assessment | Rationale |",
      "| --- | --- | --- |",
      `| Value | ${assessment.value.score === null ? "Unassessed" : `${assessment.value.score}/5`} | ${escape(assessment.value.rationale)} ${citations(assessment.value.evidence)} |`,
      `| Correctness evidence | ${assessment.correctnessEvidence.score === null ? "Unassessed" : `${assessment.correctnessEvidence.score}/5`} | ${escape(assessment.correctnessEvidence.rationale)} ${citations(assessment.correctnessEvidence.evidence)} |`,
      `| Review readiness | ${assessment.readiness} | Advisory; not merge readiness |`,
      `| Risk | ${assessment.risk} | Does not subtract from contribution value |`,
      `| Confidence | ${assessment.confidence} | Limited to captured evidence |`,
      "", `**Suggested next action:** ${assessment.recommendation}.`,
      "", "### Captured CI and CLA facts",
      "", `CLA (exact \`license/cla\` context from the verified Microsoft policy publisher): **${contribution.cla}**. A matching name alone is not CLA proof.`,
      "", "| Check | Status | Conclusion | Publisher | Evidence |", "| --- | --- | --- | --- | --- |",
      ...contribution.checks.map((check) =>
        `| ${escape(check.name)} | ${escape(check.status)} | ${escape(check.conclusion ?? "pending")} | ${escape(check.publisher)} | ${citations([check.evidenceId])} |`),
      "", "Skipped, neutral, missing, pending, and inaccessible checks are not passing test evidence. Required-check policy and live-model access are not established by this report.",
      "", "### P0 scenarios",
      ...SCENARIOS.flatMap((id) => {
        const scenario = assessment.scenarios.find((candidate) => candidate.id === id);
        if (!scenario) throw new Error(`Missing ${id}`);
        return ["", `#### ${id}: ${scenario.assessment}`, "", escape(scenario.summary), "", citations(scenario.evidence)];
      }),
      "", "### Reviewer brief", "", escape(assessment.reviewerBrief.summary),
      "", `Approval policy: **${assessment.reviewerBrief.requiredApprovals} team maintainer approval(s)**; sensitive changes also need an area expert. This workflow does not request reviewers or establish that approvals are satisfied.`,
      "", `Suggested CODEOWNERS: ${assessment.reviewerBrief.suggestedOwners.map(escape).join(", ") || "Needs maintainer routing"}.`,
      "", list(assessment.reviewerBrief.reviewOrder),
      "", "### Contributor feedback draft",
      "", "#### Required", "", list(assessment.feedback.required),
      "", "#### Optional", "", list(assessment.feedback.optional),
      "", "#### Needs maintainer decision", "", list(assessment.feedback.maintainerDecision),
      "", "### Limitations", "", list([...new Set([...contribution.limitations, ...assessment.limitations])]),
    );
  }
  return `${sections.join("\n")}\n`;
}
