// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it } from "vitest";
import { buildReadout, readoutMarkdown } from "./readout.js";
import { SCHEMA_VERSION, type Evaluation } from "./contracts.js";
const source = { id: "a", label: "A", surface_id: "surface-mcp" as const };
const context = { scenario: { id: "s", label: "Scenario", task: "task" }, profile: { id: "p", label: "Profile" } };
const e = (result: Evaluation["result"]): Evaluation => ({
  schema_version: SCHEMA_VERSION,
  element_id: "beh-timeout",
  implementation: "deterministic",
  result
});
describe("deterministic readout consumer", () => {
  it("counts run/source frequency separately from repeated occurrences with coverage and drilldowns", () => {
    const occurrences = [1, 2, 3].map(i => ({
      source: i === 3 ? { ...source, id: "b", label: "B" } : source,
      related_turns: [i],
      tool_call_id: `call-${i}`
    }));
    const report = buildReadout(
      [
        {
          context: { ...context, run_id: "one" },
          results: [e({ state: "completed", observed: true, occurrences })]
        },
        {
          context: { ...context, run_id: "two" },
          results: [e({ state: "completed", observed: true, occurrences: [occurrences[0]] })]
        },
        { context: { ...context, run_id: "three" }, results: [e({ state: "completed", observed: false })] },
        {
          context: { ...context, run_id: "four" },
          results: [e({ state: "indeterminate", reason: "partial" })]
        },
        { context: { ...context, run_id: "five" }, results: [] },
        {
          context: { ...context, run_id: "six" },
          results: [e({ state: "inapplicable", reason: "excluded" })]
        },
        { context: { ...context, run_id: "seven" }, results: [e({ state: "error", error: "failed" })] },
      ],
      ["beh-timeout"]
    );
    const behavior = report.groups[0].behaviors[0];
    expect(behavior.coverage).toEqual({ total: 7, assessed: 3, unknown: 2, missing: 1, inapplicable: 1, error: 1 });
    expect(behavior.distinct_runs).toBe(2);
    expect(behavior.occurrences).toBe(4);
    expect(behavior.sources.map(s => [s.source?.id, s.distinct_runs, s.occurrences])).toEqual([["a", 2, 3], ["b", 1, 1]]);
    expect(behavior.sources[0].evidence).toHaveLength(3);
    expect(readoutMarkdown(report)).toContain("call-2");
    expect(readoutMarkdown(report).indexOf("| Timeout |")).toBeLessThan(readoutMarkdown(report).indexOf("### Timeout evidence"));
    expect(buildReadout(JSON.parse(JSON.stringify([
      { context: { ...context, run_id: "one" }, results: [e({ state: "completed", observed: false })] },
    ])) as unknown)).toEqual(buildReadout([{ context: { ...context, run_id: "one" }, results: [e({ state: "completed", observed: false })] }]));
  });
  it("requires grouping context only at the report boundary and rejects duplicate runs/assessments", () => {
    expect(() => buildReadout([{ context: { run_id: "a" }, results: [] }])).toThrow();
    const run = { context: { ...context, run_id: "a" }, results: [e({ state: "completed", observed: false })] };
    expect(() => buildReadout([run, run])).toThrow("Duplicate run");
    expect(() => buildReadout([{ ...run, results: [...run.results, ...run.results] }])).toThrow("Duplicate element");
    const occurrence = { source, related_turns: [2], tool_call_id: "call" };
    expect(() => buildReadout([{
      ...run,
      results: [e({ state: "completed", observed: true, occurrences: [occurrence, occurrence] })]
    }])).toThrow("Duplicate occurrence");
    expect(buildReadout([{
      ...run,
      context: { ...run.context, completeness: "complete", sources: [] },
      metadata: { strategy: "deterministic" }
    }]).groups).toHaveLength(1);
  });
});
