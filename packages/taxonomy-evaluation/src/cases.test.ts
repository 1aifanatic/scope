// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { assertObservation, checkCase, loadCases, loadGold } from "./cases.js";
import { evaluate } from "./engine.js";

/** Resolves shared case/gold assets relative to this test module. */
const fixture = (name: string) => fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));

it("fails missing, duplicate and unexpected element results; explicit subsets are supported", async () => {
  // Reuse one mixed row to exercise full-selection and intentional-subset accounting.
  const row = (await loadCases(fixture("inputs.jsonl"))).find(r => r.id === "train-used")!;
  const gold = await loadGold(fixture("gold.json"));
  expect(checkCase(row, [], gold)).toHaveLength(2);
  const evaluations = await evaluate(row.input, ["beh-timeout"]);
  expect(checkCase(row, evaluations, gold)).toHaveLength(1);
  expect(checkCase(row, evaluations, gold, ["beh-timeout"])).toEqual([]);
  expect(checkCase(row, [...evaluations, ...evaluations], gold, ["beh-timeout"])).not.toEqual([]);
  expect(checkCase(row, evaluations, gold, ["beh-skipped-invocation"])).not.toEqual([]);
});
it("optional expectation fields are unconstrained, not assertions of absence", () => {
  expect(assertObservation(
    {
      state: "completed",
      observed: true,
      occurrences: [{
        source: { id: "s", label: "Source", surface_id: "surface-mcp" },
        related_turns: [2],
        tool_call_id: "c"
      }],
    },
    { state: "completed", observed: true, occurrences: [{ tool_call_id: "c" }] }
  )).toEqual([]);
});
