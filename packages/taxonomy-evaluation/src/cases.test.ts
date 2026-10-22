// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it } from "vitest";
import { evaluate } from "./engine.js";
import { createBuiltInHandlerRegistry } from "./handlers.js";
import {
  assertObservationV2,
  checkCaseV2,
  loadCasesV2,
  loadGoldV2,
} from "./cases-v2.js";
import { loadTaxonomy } from "./taxonomy.js";

async function packet() {
  const taxonomy = await loadTaxonomy(
    new URL("../taxonomies/agent-behavior/taxonomy.yaml", import.meta.url).pathname,
    { handlers: createBuiltInHandlerRegistry() },
  );
  return {
    taxonomy,
    cases: await loadCasesV2(
      new URL("../fixtures/v2/inputs.jsonl", import.meta.url).pathname,
      taxonomy,
    ),
    gold: await loadGoldV2(
      new URL("../fixtures/v2/gold.json", import.meta.url).pathname,
    ),
  };
}

describe("v2 case assertions", () => {
  it("fails missing, duplicate, and unexpected results while supporting explicit subsets", async () => {
    const { taxonomy, cases, gold } = await packet();
    const row = cases.find(candidate => candidate.id === "train-used")!;
    expect(checkCaseV2(row, [], gold)).toHaveLength(2);

    const evaluations = await evaluate(
      { atif: row.atif, taxonomy },
      ["beh-timeout"],
    );
    expect(checkCaseV2(row, evaluations, gold)).toHaveLength(1);
    expect(checkCaseV2(row, evaluations, gold, ["beh-timeout"])).toEqual([]);
    expect(checkCaseV2(
      row,
      [...evaluations, ...evaluations],
      gold,
      ["beh-timeout"],
    )).not.toEqual([]);
  });

  it("treats omitted occurrence expectation fields as unconstrained", () => {
    expect(assertObservationV2({
      state: "completed",
      observed: true,
      occurrences: [{
        source: { id: "s", label: "Source", surface_id: "surface-mcp" },
        related_turns: [2],
        tool_call_id: "c",
      }],
    }, {
      state: "completed",
      observed: true,
      occurrences: [{ tool_call_id: "c" }],
    })).toEqual([]);
  });
});
