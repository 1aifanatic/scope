// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { z } from "zod";
import { behaviorMetadata } from "./engine.js";
import { contextSchema, elementIdSchema, evaluationSchema, skippedResultSchema, timeoutResultSchema, occurrenceIdentity, type ElementId, type Evaluation, type Source } from "./contracts.js";

const groupingSchema = contextSchema.pick({ run_id: true, scenario: true, profile: true }).required().passthrough();
export interface ReadoutRun {
  context: z.infer<typeof groupingSchema>;
  results: Evaluation[];
}
const runSchema = z.object({ context: groupingSchema, results: z.array(evaluationSchema), metadata: z.unknown().optional() }).strict();
export function parseReadoutRuns(value: unknown): ReadoutRun[] {
  return z.array(runSchema).parse(value).map(run => ({
    context: run.context,
    results: run.results.map(e => ({
      ...e, result: e.element_id === "beh-timeout" ? timeoutResultSchema.parse(e.result) : skippedResultSchema.parse(e.result),
    })),
  }));
}
export function buildReadout(value: unknown, selection: readonly ElementId[] = elementIdSchema.options) {
  const runs = parseReadoutRuns(value);
  if (!selection.length || new Set(selection).size !== selection.length) throw new Error("Readout needs unique selected elements");
  const seen = new Set<string>();
  for (const run of runs) {
    if (seen.has(run.context.run_id)) throw new Error("Duplicate run in readout; provide one assessment per run");
    seen.add(run.context.run_id);
    if (new Set(run.results.map(r => r.element_id)).size !== run.results.length) throw new Error("Duplicate element assessment within run");
    for (const { result } of run.results) {
      if (result.state === "completed" && result.observed &&
          new Set(result.occurrences.map(occurrenceIdentity)).size !== result.occurrences.length) {
        throw new Error("Duplicate occurrence within readout assessment");
      }
    }
  }
  const groups = new Map<string, ReadoutRun[]>();
  for (const run of runs) {
    const key = JSON.stringify([run.context.scenario.id, run.context.profile.id]);
    const group = groups.get(key) ?? [];
    if (group.some(r => r.context.scenario.label !== run.context.scenario.label || r.context.profile.label !== run.context.profile.label)) {
      throw new Error("Inconsistent grouping labels");
    }
    group.push(run); groups.set(key, group);
  }
  const output = [...groups.values()].map(group => ({
    scenario: group[0].context.scenario,
    profile: group[0].context.profile,
    behaviors: selection.map(element_id => {
      const coverage = { total: group.length, assessed: 0, unknown: 0, inapplicable: 0, error: 0, missing: 0 };
      const pairs = new Map<string, { source?: Source; runs: Set<string>; occurrences: number; evidence: unknown[] }>();
      let distinct_runs = 0, occurrences = 0;
      for (const run of group) {
        const result = run.results.find(r => r.element_id === element_id)?.result;
        if (!result) { coverage.unknown++; coverage.missing++; continue; }
        if (result.state !== "completed") {
          if (result.state === "indeterminate") coverage.unknown++;
          else coverage[result.state]++;
          continue;
        }
        coverage.assessed++;
        if (!result.observed) continue;
        distinct_runs++;
        occurrences += result.occurrences.length;
        for (const occurrence of result.occurrences) {
          const key = occurrence.source ? JSON.stringify([occurrence.source.surface_id, occurrence.source.id]) : "unattributed";
          const pair = pairs.get(key) ?? { source: occurrence.source, runs: new Set<string>(), occurrences: 0, evidence: [] };
          if (pair.source?.label !== occurrence.source?.label) throw new Error("Inconsistent source labels for one identity");
          pair.runs.add(run.context.run_id); pair.occurrences++;
          pair.evidence.push({ run_id: run.context.run_id, ...occurrence });
          pairs.set(key, pair);
        }
      }
      return {
        element_id, ...behaviorMetadata[element_id], coverage, distinct_runs, occurrences,
        sources: [...pairs.values()].map(p => ({ ...(p.source ? { source: p.source } : {}), distinct_runs: p.runs.size, occurrences: p.occurrences, evidence: p.evidence })),
      };
    }),
  }));
  return { schema_version: "taxonome.readout.v1", groups: output };
}
function cell(value: string) { return value.replaceAll("|", "\\|").replaceAll("\n", " "); }
export function readoutMarkdown(report: ReturnType<typeof buildReadout>): string {
  const lines = ["# Taxonome behavior preview", ""];
  for (const group of report.groups) {
    lines.push(`## ${cell(group.scenario.label)} / ${cell(group.profile.label)}`, "",
      "| Behavior / source | Distinct runs / total | Occurrences | Assessed | Unknown | Inapplicable | Error |",
      "|---|---:|---:|---:|---:|---:|---:|");
    for (const behavior of group.behaviors) {
      const c = behavior.coverage;
      lines.push(`| ${behavior.label} | ${behavior.distinct_runs}/${c.total} | ${behavior.occurrences} | ${c.assessed} | ${c.unknown} | ${c.inapplicable} | ${c.error} |`);
      for (const source of behavior.sources) {
        lines.push(`| ${behavior.label} / ${cell(source.source?.label ?? "(unattributed)")} | ${source.distinct_runs}/${c.total} | ${source.occurrences} | ${c.assessed} | ${c.unknown} | ${c.inapplicable} | ${c.error} |`);
      }
    }
    lines.push("");
    for (const behavior of group.behaviors) {
      if (behavior.sources.length) lines.push(`### ${behavior.label} evidence`, "",
        "Stable run, turn and call identities:", "", "```json",
        JSON.stringify(behavior.sources.flatMap(s => s.evidence), null, 2), "```", "");
    }
  }
  return lines.join("\n");
}
