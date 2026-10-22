// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it } from "vitest";
import {
  type DeterministicHandlerInput,
  HandlerRegistry,
  loadTaxonomy,
  type ScopeSource,
} from "taxonomy-evaluation";
import {
  loadCasesV2,
  loadGoldV2,
} from "taxonomy-evaluation/cases-v2";
import {
  retryHandler,
  retryOutputSchema,
  type RetryOutput,
} from "../../../examples/taxonome-custom-handler/src/handlers/index.js";

const source: ScopeSource = {
  id: "account/query",
  label: "account/query",
  surface_id: "surface-mcp",
};

const producerSamples: RetryOutput[] = [
  {
    state: "completed",
    observed: true,
    occurrences: [{
      source,
      related_turns: [2],
      tool_call_id: "retry-1",
      attempts: 3,
    }],
  },
  { state: "completed", observed: false },
  { state: "indeterminate", reason: "Trajectory evidence is partial." },
  { state: "error", error: "Handler execution failed." },
];

describe("custom retry handler output contract", () => {
  it("keeps the TypeScript producer schema consistent with element YAML", async () => {
    const handlers = new HandlerRegistry();
    handlers.register({ "acme/retry-loop-v1": retryHandler }, {
      name: "taxonome-custom-handler-example",
      version: "1.0.0",
      origin: "local",
    });
    const taxonomy = await loadTaxonomy(
      new URL(
        "../../../examples/taxonome-custom-handler/taxonomy.yaml",
        import.meta.url,
      ).pathname,
      { handlers },
    );
    const element = taxonomy.elementById.get("acme-retry-loop");
    expect(element).toBeDefined();

    for (const sample of producerSamples) {
      expect(retryOutputSchema.parse(sample)).toEqual(sample);
      expect(element!.validateOutput(sample)).toEqual([]);
    }
  });

  it("does not turn unattributed positive retry evidence into a negative", () => {
    const input: DeterministicHandlerInput = {
      taxonomy: {
        schema_version: "scope/taxonomy/v1",
        id: "fixture",
        version: "1.0.0",
        digest: "fixture",
        surfaces: [],
      },
      atif: {
        schema_version: "ATIF-v1.7",
        session_id: "unattributed-retry",
        agent: { name: "fixture" },
        steps: [{
          step_id: 1,
          source: "agent",
          message: "Retry completed.",
          tool_calls: [{
            tool_call_id: "retry-1",
            function_name: "query",
            arguments: {},
            extra: {
              scope: {
                response: { recovered: true, attempts: 3 },
              },
            },
          }],
        }],
        extra: {
          scope: {
            schema_version: "scope.atif-extension.v1",
            trajectory_state: "complete",
            available_sources: [],
          },
        },
      },
    };

    expect(retryHandler.evaluate(input, { min_attempts: 2 })).toEqual({
      state: "indeterminate",
      reason: "Recovered retry evidence is missing source attribution.",
    });
  });

  it("loads a disjoint custom prompt corpus with separate reviewed gold", async () => {
    const handlers = new HandlerRegistry();
    handlers.register({ "acme/retry-loop-v1": retryHandler }, {
      name: "taxonome-custom-handler-example",
      version: "1.0.0",
      origin: "local",
    });
    const root = new URL(
      "../../../examples/taxonome-custom-handler/",
      import.meta.url,
    );
    const taxonomy = await loadTaxonomy(
      new URL("taxonomy.yaml", root).pathname,
      { handlers },
    );
    const cases = await loadCasesV2(
      new URL("cases/prompt-cases.jsonl", root).pathname,
      taxonomy,
    );
    const gold = await loadGoldV2(
      new URL("cases/prompt-gold.json", root).pathname,
    );

    expect(taxonomy.elementById.get("acme-repeated-request")?.implementation)
      .toMatchObject({ type: "prompt" });
    expect(cases.map(row => row.split)).toEqual([
      "train",
      "train",
      "validation",
      "validation",
      "heldout",
      "heldout",
    ]);
    expect(new Set(cases.map(row => row.family))).toHaveLength(cases.length);
    expect(new Set(cases.map(row => row.originating_run)))
      .toHaveLength(cases.length);
    expect(Object.keys(gold)).toEqual(cases.map(row => row.id));
    const transcript = cases
      .flatMap(row => row.atif.steps.map(step => step.message))
      .join("\n");
    expect(transcript).not.toContain("acme-repeated-request");
    expect(transcript).not.toContain("Repeated Information Request");
  });
});
