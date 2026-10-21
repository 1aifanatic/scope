// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it } from "vitest";
import { loadCases } from "./cases.js";
import { fileURLToPath } from "node:url";
import { prepareInput, skippedResultSchema, timeoutResultSchema, validateResult } from "./contracts.js";

/** @returns Shared packet loaded through the production case boundary. */
const cases = () => loadCases(fileURLToPath(new URL("../fixtures/inputs.jsonl", import.meta.url)));

describe("Schema-Declared Observation v1", () => {
  it.each([skippedResultSchema, timeoutResultSchema])(
    "rejects confidence, category duplication and all invalid conditional metadata",
    schema => {
      expect(schema.safeParse({ state: "completed", observed: false }).success).toBe(true);
      for (const bad of [
        { state: "completed", observed: false, confidence: 1 },
        { state: "completed", observed: false, category_id: "category" },
        { state: "completed", observed: false, occurrences: [] },
        { state: "completed", observed: true },
        { state: "completed", observed: true, occurrences: [] },
        { state: "indeterminate", reason: "missing", observed: false },
        { state: "error", error: "" },
      ]) expect(schema.safeParse(bad).success).toBe(false);
    });
  it("preserves ATIF order, identities, metrics, durations and unknown extensions", async () => {
    // Passthrough fields remain intact, while reversed step order is rejected.
    const row = (await cases()).find(c => c.id === "train-mixed")!;
    row.input.atif.extra = { unknown: [1, 2, 3] };
    const parsed = prepareInput(row.input);
    expect(parsed).toEqual(row.input);
    expect(parsed.atif.steps[2].tool_calls![0].extra?.duration_ms).toBe(30000);
    const reversed = structuredClone(row.input);
    reversed.atif.steps.reverse();
    expect(() => prepareInput(reversed)).toThrow("order");
  });
  it("rejects wrong version, duplicate IDs, dangling calls and undeclared surfaces", async () => {
    const input = (await cases())[0].input;
    expect(() => prepareInput({ ...input, atif: { ...input.atif, schema_version: "ATIF-v2" } })).toThrow();
    expect(() => prepareInput({
      ...input,
      context: { ...input.context, sources: [{ id: "x", label: "X", surface_id: "invented" }] }
    })).toThrow();
    const duplicate = structuredClone(input);
    duplicate.atif.steps.push(duplicate.atif.steps[0]);
    expect(() => prepareInput(duplicate)).toThrow();
  });
  it("enforces actual typed sources and step/call grounding", async () => {
    // Start from one valid positive, then mutate one attribution invariant at a time.
    const row = (await cases())[0];
    const source = row.input.context.sources[0];
    const valid = {
      state: "completed",
      observed: true,
      occurrences: [{ source, extension_point: "storage-skill", discovery_turn: 2 }]
    };
    expect(validateResult("beh-skipped-invocation", valid, row.input)).toEqual(valid);
    expect(() => validateResult(
      "beh-skipped-invocation",
      { ...valid, occurrences: [{ ...valid.occurrences[0], source: { ...source, label: "invented" } }] },
      row.input
    )).toThrow("supplied");
    expect(() => validateResult(
      "beh-skipped-invocation",
      { ...valid, occurrences: [{ ...valid.occurrences[0], discovery_turn: 500 }] },
      row.input
    )).toThrow("turn");
  });
});
