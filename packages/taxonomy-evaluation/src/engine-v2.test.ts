// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { describe, expect, it, vi } from "vitest";
import { evaluate } from "./engine.js";
import {
  createBuiltInHandlerRegistry,
  HandlerRegistry,
} from "./handlers.js";
import { parseScopeAtif } from "./scope-atif.js";
import { loadTaxonomy } from "./taxonomy.js";

async function taxonomy() {
  return loadTaxonomy(
    new URL("../taxonomies/agent-behavior/taxonomy.yaml", import.meta.url).pathname,
    { handlers: createBuiltInHandlerRegistry() },
  );
}

/** Reads one v2 case row by ID from committed JSONL. */
async function caseAtif(id: string) {
  const rows = (await readFile(
    new URL("../fixtures/v2/final-inputs.jsonl", import.meta.url),
    "utf8",
  )).trim().split("\n").map(line => JSON.parse(line) as {
    id: string;
    atif: unknown;
  });
  return parseScopeAtif(rows.find(row => row.id === id)!.atif);
}

describe("YAML-loaded taxonomy engine", () => {
  it("evaluates deterministic Timeout with zero prompt executor calls", async () => {
    const loaded = await taxonomy();
    const atif = parseScopeAtif(JSON.parse(await readFile(
      new URL("../fixtures/v2/timeout.atif.json", import.meta.url),
      "utf8",
    )) as unknown);
    const executor = { evaluate: vi.fn() };
    const before = structuredClone(atif);

    const [evaluation] = await evaluate(
      { atif, taxonomy: loaded },
      ["beh-timeout"],
      executor,
    );

    expect(evaluation).toMatchObject({
      schema_version: "scope/taxonomy-evaluation/v1",
      taxonomy: {
        id: "agent-behavior",
        version: "2.0.0",
        digest: loaded.digest,
      },
      element: {
        id: "beh-timeout",
        label: "Timeout",
        category_id: "behavior-category-invocation",
      },
      implementation: {
        type: "deterministic",
        handler: "scope/timeout-v1",
        provider: { origin: "builtin" },
      },
      result: {
        state: "completed",
        observed: true,
        occurrences: [{
          related_turns: [2],
          tool_call_id: "query-1",
        }],
      },
    });
    expect(executor.evaluate).not.toHaveBeenCalled();
    expect(atif).toEqual(before);
    expect(Object.isFrozen(atif)).toBe(false);
    expect(Object.isFrozen(atif.steps[0])).toBe(false);
  });

  it("uses loaded prompt instructions and grounds a positive discovery occurrence", async () => {
    const loaded = await taxonomy();
    const atif = await caseAtif("final-login");
    const executor = {
      evaluate: vi.fn(async element => {
        expect(element.implementation).toMatchObject({
          type: "prompt",
          prompt: expect.stringContaining("Assess Skipped Invocation"),
        });
        return {
          state: "completed",
          observed: true,
          occurrences: [{
            extension_point: "login/configure",
            source: {
              id: "ep-071",
              label: "login/configure",
              surface_id: "surface-auth",
            },
            discovery_turn: 2,
          }],
        };
      }),
    };

    const [evaluation] = await evaluate(
      { atif, taxonomy: loaded },
      ["beh-skipped-invocation"],
      executor,
    );

    expect(evaluation.result).toMatchObject({
      state: "completed",
      observed: true,
    });
    expect(executor.evaluate).toHaveBeenCalledOnce();
  });

  it("preflights incomplete absence claims without calling a prompt and keeps explicit Timeout positive", async () => {
    const loaded = await taxonomy();
    const atif = await caseAtif("final-partial-mixed");
    const executor = { evaluate: vi.fn() };

    const [skipped, timeout] = await evaluate(
      { atif, taxonomy: loaded },
      ["beh-skipped-invocation", "beh-timeout"],
      executor,
    );

    expect(skipped.result).toMatchObject({ state: "indeterminate" });
    expect(timeout.result).toMatchObject({ state: "completed", observed: true });
    expect(executor.evaluate).not.toHaveBeenCalled();
  });

  it("rejects invented sources and discoveries after authored-schema validation", async () => {
    const loaded = await taxonomy();
    const atif = await caseAtif("final-login");
    const executor = {
      evaluate: vi.fn(async () => ({
        state: "completed",
        observed: true,
        occurrences: [{
          extension_point: "invented",
          source: {
            id: "invented",
            label: "Invented",
            surface_id: "surface-auth",
          },
          discovery_turn: 2,
        }],
      })),
    };

    await expect(evaluate(
      { atif, taxonomy: loaded },
      ["beh-skipped-invocation"],
      executor,
    )).rejects.toThrow(/not a supplied Scope source|not grounded/);
  });

  it("defaults plain ATIF to complete and rejects duplicate selections", async () => {
    const loaded = await taxonomy();
    const atif = parseScopeAtif({
      schema_version: "ATIF-v1.7",
      session_id: "plain",
      agent: { name: "fixture" },
      steps: [{ step_id: 1, source: "user", message: "Say hello." }],
    });

    expect(atif.extra?.scope?.trajectory_state).toBe("complete");
    await expect(evaluate(
      { atif, taxonomy: loaded },
      ["beh-timeout", "beh-timeout"],
    )).rejects.toThrow("unique element selection");
  });

  it("exposes no mutable taxonomy maps to plugins and grounds every related turn", async () => {
    const directory = await mkdtemp(join(tmpdir(), "taxonome-handler-input-"));
    try {
      const registry = new HandlerRegistry();
      registry.register({
        "acme/grounding-test-v1": {
          configSchema: z.object({}).strict(),
          evaluate(input, config) {
            expect(Object.isFrozen(input)).toBe(true);
            expect(Object.isFrozen(input.atif)).toBe(true);
            expect(Object.isFrozen(config)).toBe(true);
            expect("elementById" in input.taxonomy).toBe(false);
            expect("surfaceById" in input.taxonomy).toBe(false);
            return {
              state: "completed",
              observed: true,
              occurrences: [{
                related_turns: [1, 999],
                tool_call_id: "call-1",
              }],
            };
          },
        },
      }, {
        name: "grounding-test",
        origin: "local",
      });
      const path = join(directory, "taxonomy.yaml");
      await writeFile(path, `
schema_version: scope/taxonomy/v1
id: grounding-test
version: 1.0.0
surfaces: []
elements:
  - id: grounding
    label: Grounding
    implementation:
      type: deterministic
      handler: acme/grounding-test-v1
    evidence:
      requires_discovery_event: false
      complete_for_negative: false
      requires_task: false
    output_schema:
      type: object
      additionalProperties: false
      required: [state, observed, occurrences]
      properties:
        state: { const: completed }
        observed: { const: true }
        occurrences:
          type: array
          minItems: 1
          items:
            type: object
            additionalProperties: false
            required: [related_turns, tool_call_id]
            properties:
              related_turns:
                type: array
                minItems: 1
                items: { type: integer, minimum: 1 }
              tool_call_id: { type: string }
`);
      const loaded = await loadTaxonomy(path, { handlers: registry });
      const atif = parseScopeAtif({
        schema_version: "ATIF-v1.7",
        session_id: "grounding",
        agent: { name: "fixture" },
        steps: [{
          step_id: 1,
          source: "agent",
          message: "Called.",
          tool_calls: [{
            tool_call_id: "call-1",
            function_name: "query",
            arguments: {},
          }],
        }],
      });

      await expect(evaluate(
        { atif, taxonomy: loaded },
        ["grounding"],
      )).rejects.toThrow(/related_turns contains unknown step 999/);
      expect(loaded.elementById.has("grounding")).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
