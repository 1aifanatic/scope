// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { z } from "zod";
import {
  contextSchema,
  elementIdSchema,
  evaluationSchema,
  skippedResultSchema,
  timeoutResultSchema,
  occurrenceIdentity,
  type ElementId,
  type LegacyEvaluation,
  type Source,
} from "./contracts.js";

const behaviorMetadata: Record<ElementId, {
  label: string;
  category_id: string;
}> = {
  "beh-skipped-invocation": {
    label: "Skipped Invocation",
    category_id: "behavior-category-invocation",
  },
  "beh-timeout": {
    label: "Timeout",
    category_id: "behavior-category-invocation",
  },
};

const groupingSchema = contextSchema.pick({ run_id: true, scenario: true, profile: true }).required().passthrough();

/** One run supplied to the deterministic reporting boundary. */
export interface ReadoutRun {
  /** Required run/scenario/profile grouping context; extra evaluation metadata is preserved. */
  context: z.infer<typeof groupingSchema>;
  /** Validated element evaluations available for this run. Missing elements count unknown. */
  results: LegacyEvaluation[];
}

const runSchema = z.object({ context: groupingSchema, results: z.array(evaluationSchema), metadata: z.unknown().optional() }).strict();

/**
 * Requires explicit reporting context, without making it mandatory for evaluation.
 *
 * @param value - Untrusted JSON array of readout runs.
 * @returns Runs with element-specific result unions narrowed.
 */
export function parseReadoutRuns(value: unknown): ReadoutRun[] {
  return z.array(runSchema).parse(value).map(run => ({
    context: run.context,
    results: run.results.map(evaluation => ({
      ...evaluation,
      result: evaluation.element_id === "beh-timeout"
        ? timeoutResultSchema.parse(evaluation.result)
        : skippedResultSchema.parse(evaluation.result),
    })),
  }));
}

/**
 * Aggregates assessments without inference; duplicate identities fail instead of inflating counts.
 *
 * @param value - Untrusted readout-run array.
 * @param selection - Unique element IDs to report; defaults to all registered elements.
 * @returns JSON-safe scenario/profile groups with coverage, run frequency, occurrence counts, and evidence.
 */
export function buildReadout(value: unknown, selection: readonly ElementId[] = elementIdSchema.options) {
  const runs = parseReadoutRuns(value);
  if (!selection.length || new Set(selection).size !== selection.length) {
    throw new Error("Readout needs unique selected elements");
  }

  const seenRunIds = new Set<string>();
  for (const run of runs) {
    if (seenRunIds.has(run.context.run_id)) {
      throw new Error("Duplicate run in readout; provide one assessment per run");
    }
    seenRunIds.add(run.context.run_id);

    if (new Set(run.results.map(evaluation => evaluation.element_id)).size !== run.results.length) {
      throw new Error("Duplicate element assessment within run");
    }

    for (const { result } of run.results) {
      if (
        result.state === "completed" &&
        result.observed &&
        new Set(result.occurrences.map(occurrenceIdentity)).size !== result.occurrences.length
      ) {
        throw new Error("Duplicate occurrence within readout assessment");
      }
    }
  }

  // Counts share a denominator only within the same explicit scenario/profile.
  const groups = new Map<string, ReadoutRun[]>();
  for (const run of runs) {
    const key = JSON.stringify([run.context.scenario.id, run.context.profile.id]);
    const group = groups.get(key) ?? [];
    if (group.some(candidate => candidate.context.scenario.label !== run.context.scenario.label || candidate.context.profile.label !== run.context.profile.label)) {
      throw new Error("Inconsistent grouping labels");
    }
    group.push(run);
    groups.set(key, group);
  }

  const output = [...groups.values()].map(group => ({
    scenario: group[0].context.scenario,
    profile: group[0].context.profile,
    behaviors: selection.map(element_id => {
      const coverage = { total: group.length, assessed: 0, unknown: 0, inapplicable: 0, error: 0, missing: 0 };
      const sourceCounts = new Map<string, {
        source?: Source;
        runs: Set<string>;
        occurrences: number;
        evidence: unknown[];
      }>();
      let distinctRuns = 0;
      let occurrenceCount = 0;

      for (const run of group) {
        const result = run.results.find(evaluation => evaluation.element_id === element_id)?.result;
        if (!result) {
          coverage.unknown++;
          coverage.missing++;
          continue;
        }

        if (result.state !== "completed") {
          if (result.state === "indeterminate") {
            coverage.unknown++;
          } else {
            coverage[result.state]++;
          }
          continue;
        }

        coverage.assessed++;
        if (!result.observed) {
          continue;
        }

        distinctRuns++;
        occurrenceCount += result.occurrences.length;
        for (const occurrence of result.occurrences) {
          const key = occurrence.source ? JSON.stringify([occurrence.source.surface_id, occurrence.source.id]) : "unattributed";
          const sourceCount = sourceCounts.get(key) ?? {
            source: occurrence.source,
            runs: new Set<string>(),
            occurrences: 0,
            evidence: [],
          };
          if (sourceCount.source?.label !== occurrence.source?.label) {
            throw new Error("Inconsistent source labels for one identity");
          }

          // Repeated occurrences count independently, but their run contributes only once.
          sourceCount.runs.add(run.context.run_id);
          sourceCount.occurrences++;
          sourceCount.evidence.push({ run_id: run.context.run_id, ...occurrence });
          sourceCounts.set(key, sourceCount);
        }
      }

      return {
        element_id,
        ...behaviorMetadata[element_id],
        coverage,
        distinct_runs: distinctRuns,
        occurrences: occurrenceCount,
        sources: [...sourceCounts.values()].map(sourceCount => ({
          ...(sourceCount.source ? { source: sourceCount.source } : {}),
          distinct_runs: sourceCount.runs.size,
          occurrences: sourceCount.occurrences,
          evidence: sourceCount.evidence,
        })),
      };
    }),
  }));

  return { schema_version: "taxonome.readout.v1", groups: output };
}

/**
 * Escapes one dynamic Markdown-table cell.
 *
 * @param value - Display label that may contain pipes or line breaks.
 */
function markdownCell(value: string) {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

/**
 * Renders the same deterministic counts and evidence drilldowns as a compact Markdown preview.
 *
 * @param report - Output returned by {@link buildReadout}.
 * @returns Markdown with one table and evidence sections per scenario/profile group.
 */
export function readoutMarkdown(report: ReturnType<typeof buildReadout>): string {
  const lines = ["# Taxonome behavior preview", ""];
  for (const group of report.groups) {
    lines.push(
      `## ${markdownCell(group.scenario.label)} / ${markdownCell(group.profile.label)}`,
      "",
      "| Behavior / source | Distinct runs / total | Occurrences | Assessed | Unknown | Inapplicable | Error |",
      "|---|---:|---:|---:|---:|---:|---:|"
    );
    for (const behavior of group.behaviors) {
      const coverage = behavior.coverage;
      lines.push(`| ${behavior.label} | ${behavior.distinct_runs}/${coverage.total} | ${behavior.occurrences} | ${coverage.assessed} | ${coverage.unknown} | ${coverage.inapplicable} | ${coverage.error} |`);
      for (const source of behavior.sources) {
        lines.push(`| ${behavior.label} / ${markdownCell(source.source?.label ?? "(unattributed)")} | ${source.distinct_runs}/${coverage.total} | ${source.occurrences} | ${coverage.assessed} | ${coverage.unknown} | ${coverage.inapplicable} | ${coverage.error} |`);
      }
    }

    lines.push("");
    for (const behavior of group.behaviors) {
      if (behavior.sources.length) {
        lines.push(
          `### ${behavior.label} evidence`,
          "",
          "Stable run, turn and call identities:",
          "",
          "```json",
          JSON.stringify(behavior.sources.flatMap(source => source.evidence), null, 2),
          "```",
          ""
        );
      }
    }
  }

  return lines.join("\n");
}
