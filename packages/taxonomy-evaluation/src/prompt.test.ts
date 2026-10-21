// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadCases, loadGold, assertObservation } from "./cases.js";
import { standaloneTargets, listStandaloneTargets } from "../../../evaluations/static-prompts/adapter/standalone.js";
import { OBSERVATION_CONTRACT, SKIPPED_INSTRUCTIONS } from "./prompt.js";

/**
 * Resolves prompt case assets relative to this test module.
 *
 * @param name - Fixture filename under the package fixtures directory.
 */
const fixture = (name: string) => fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));

describe("static prompt family composition and curated contract (offline, not model evidence)", () => {
  it("registers the real SDK-only family and invokes the production program unchanged", async () => {
    // The fake transport captures the exact production composition without substituting a prompt copy.
    const cases = await loadCases(fixture("inputs.jsonl")), gold = await loadGold(fixture("gold.json"));
    const row = cases.find(c => c.id === "train-none")!;
    expect(listStandaloneTargets()).toContainEqual({
      adapterId: "taxonome-skipped-invocation/default",
      family: "taxonome-skipped-invocation",
      variant: "default",
      transport: "copilot-sdk"
    });
    let calls = 0;
    const output = await standaloneTargets["taxonome-skipped-invocation/default"].run(
      row.input,
      {
        complete: async (system, user) => {
          calls++;
          expect(system.startsWith(OBSERVATION_CONTRACT)).toBe(true);
          expect(system).toContain(SKIPPED_INSTRUCTIONS);
          expect(user).toContain(JSON.stringify(row.input.atif).slice(1, -1));
          expect(user).not.toContain("expected");
          return { content: 'Observation: {"state":"completed","observed":false}' };
        },
        close: async () => { },
      },
      "mock"
    );
    expect(calls).toBe(1);
    expect(assertObservation(output, gold[row.id]["beh-skipped-invocation"]!)).toEqual([]);
    const trainingFamilies = new Set(cases.filter(c => c.split === "train").map(c => c.family));
    expect(cases.filter(c => c.split === "heldout").some(c => trainingFamilies.has(c.family))).toBe(false);
  });
  it("keeps identifiers opaque and renaming does not alter evidence/gold or the contract", async () => {
    // Rename only opaque identities and assert semantic evidence still drives the same validated output.
    const rows = await loadCases(fixture("inputs.jsonl"));
    for (const row of rows) expect(row.input.atif.session_id).toMatch(/^traj-\d+$/);
    const input = structuredClone(rows[0].input);
    const original = structuredClone(input);
    input.atif.session_id = "z-identifier";
    if (input.context.run_id) input.context.run_id = "r-identifier";
    const output = await standaloneTargets["taxonome-skipped-invocation/default"].run(
      input,
      {
        complete: async (_system, user) => {
          expect(user).toContain("z-identifier");
          expect(user).not.toContain(original.atif.session_id);
          expect(user).toContain(original.atif.steps[1].message);
          return {
            content: `Observation: ${JSON.stringify({
              state: "completed",
              observed: true,
              occurrences: [{ source: input.context.sources[0], extension_point: "storage-skill", discovery_turn: 2 }]
            })}`
          };
        },
        close: async () => { },
      },
      "mock"
    );
    expect(output).toMatchObject({ state: "completed", observed: true });
  });
});
