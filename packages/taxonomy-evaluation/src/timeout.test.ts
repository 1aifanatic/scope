// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { evaluate, evaluateElement, prepareInput, type TaxonomyInput } from "./index.js";
import { assertObservation, checkCase, loadCases, loadGold, type Expectation } from "./cases.js";
vi.mock("@github/copilot-sdk", () => {
  throw new Error("Deterministic execution must not load the SDK");
});
vi.mock("@ax-llm/ax", () => {
  throw new Error("Deterministic execution must not load Ax");
});

/**
 * Resolves committed case assets relative to this test module.
 *
 * @param name - Fixture filename under the package fixtures directory.
 */
const fixture = (name: string) => fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));

/** @returns The smallest valid Timeout input for focused evidence mutations. */
async function base(): Promise<TaxonomyInput> {
  return prepareInput({
    atif: JSON.parse(await readFile(fixture("timeout.atif.json"), "utf8")) as unknown,
    context: { completeness: "complete", sources: [] },
  });
}

/**
 * Runs only the deterministic element.
 *
 * @param input - Input variant being exercised.
 * @returns Semantic Timeout result without the outer evaluation envelope.
 */
async function result(input: unknown) {
  return (await evaluate(input, ["beh-timeout"]))[0].result;
}

describe("Timeout through the public API", () => {
  it("shares the ATIF/gold assertion packet with prompt evaluations", async () => {
    const cases = await loadCases(fixture("inputs.jsonl")), gold = await loadGold(fixture("gold.json"));
    for (const row of cases.filter(c => c.elements.includes("beh-timeout"))) {
      const evaluations = await evaluate(row.input, ["beh-timeout"]);
      expect(checkCase(row, evaluations, gold, ["beh-timeout"]), row.id).toEqual([]);
    }
  });

  // The table exercises each evidence/policy branch without duplicating test control flow.
  it.each([
    [
      "explicit timeout",
      { outcome: "timeout" },
      undefined,
      {
        state: "completed",
        observed: true,
        occurrences: [{ tool_call_id: "query-1", related_turns: [2] }]
      }
    ],
    ["explicit timeout on partial run", { outcome: "timeout" }, undefined, { state: "completed", observed: true }],
    ["policy boundary", { outcome: "abandoned", duration_ms: 1000 }, 1000, { state: "completed", observed: true }],
    ["below boundary", { outcome: "abandoned", duration_ms: 999 }, 1000, { state: "completed", observed: false }],
    ["stalled", { outcome: "pending", duration_ms: 1001 }, 1000, { state: "completed", observed: true }],
    [
      "normal completion",
      { outcome: "completed", duration_ms: 20, progress_interrupted: false },
      1000,
      { state: "completed", observed: false }
    ],
    [
      "slow without interruption",
      { outcome: "completed", duration_ms: 5000, progress_interrupted: false },
      1000,
      { state: "completed", observed: false }
    ],
    [
      "slow with interruption",
      { outcome: "completed", duration_ms: 5000, progress_interrupted: true },
      1000,
      { state: "completed", observed: true }
    ],
    ["slow missing interruption evidence", { outcome: "completed", duration_ms: 5000 }, 1000, { state: "indeterminate" }],
    ["quick non-timeout error", { outcome: "error", duration_ms: 10 }, 1000, { state: "completed", observed: false }],
    ["missing timing", { outcome: "completed" }, 1000, { state: "indeterminate" }],
    ["no guessed universal cutoff", { outcome: "abandoned", duration_ms: 9000000 }, undefined, { state: "indeterminate" }],
    [
      "completion without a policy or interruption attestation",
      { outcome: "completed", duration_ms: 5000 },
      undefined,
      { state: "indeterminate" }
    ],
    [
      "explicit no interruption needs no guessed cutoff",
      { outcome: "completed", duration_ms: 5000, progress_interrupted: false },
      undefined,
      { state: "completed", observed: false }
    ],
    [
      "contradictory timing",
      {
        outcome: "timeout",
        duration_ms: 10,
        started_at: "2026-01-01T00:00:00Z",
        ended_at: "2026-01-01T00:00:02Z"
      },
      1000,
      { state: "indeterminate" }
    ],
    [
      "reversed timing",
      { outcome: "timeout", started_at: "2026-01-01T00:00:02Z", ended_at: "2026-01-01T00:00:00Z" },
      1000,
      { state: "indeterminate" }
    ],
    [
      "timestamp duration",
      { outcome: "abandoned", started_at: "2026-01-01T00:00:00Z", ended_at: "2026-01-01T00:00:01Z" },
      1000,
      { state: "completed", observed: true }
    ],
  ] as const)(
    "%s",
    async (name, meta, threshold, expected) => {
      const input = await base();
      input.atif.steps[1].tool_calls![0].extra = { ...meta };
      if (threshold) input.context.timeout_policy = { threshold_ms: threshold };
      if (name.includes("partial")) input.context.completeness = "partial";
      const actual = await result(input);
      expect(assertObservation(actual, expected as Expectation)).toEqual([]);
    });
  it("has no calls in a complete run: exact completed absence", async () => {
    const input = await base();
    delete input.atif.steps[1].tool_calls;
    const actual = await result(input);
    expect(assertObservation(actual, { state: "completed", observed: false, exact: { state: "completed", observed: false } })).toEqual([]);
    input.context.completeness = "partial";
    expect((await result(input)).state).toBe("indeterminate");
  });
  it("handles different and repeated sources without collapsing call occurrences", async () => {
    // Three calls include one repeated source so run frequency and occurrences remain distinct.
    const input = await base();
    input.context.sources = [{ id: "a", label: "A", surface_id: "surface-mcp" }, { id: "b", label: "B", surface_id: "surface-cli" }];
    input.atif.steps[1].tool_calls = ["a", "a", "b"].map((source_id, i) => ({
      tool_call_id: `call-${i}`,
      function_name: "query",
      arguments: {},
      extra: { outcome: "timeout", source_id },
    }));
    expect(await result(input)).toEqual({
      state: "completed",
      observed: true,
      occurrences: input.atif.steps[1].tool_calls.map(c => ({
        related_turns: [2],
        tool_call_id: c.tool_call_id,
        source: input.context.sources.find(s => s.id === c.extra!.source_id),
      }))
    });
  });
  it("does not mutate even passthrough/nested evidence; repeated execution is stable; no SDK or token is needed", async () => {
    vi.stubEnv("COPILOT_GITHUB_TOKEN", "");
    try {
      const input = await base();
      input.atif.extra = { preserved: { values: [1, 2] } };
      const before = structuredClone(input);
      const executor = {
        evaluate: vi.fn(() => {
          throw new Error("SDK must never initialize");
        })
      };
      const first = await evaluate(input, ["beh-timeout"], executor);
      const second = await evaluate(input, ["beh-timeout"], executor);

      expect(first).toEqual(second);
      expect(input).toEqual(before);
      expect(executor.evaluate).not.toHaveBeenCalled();
      expect(Object.isFrozen(input.atif.steps[1].tool_calls![0].arguments)).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it("is invariant to timestamp shifts and unrelated IDs", async () => {
    const input = await base();
    input.atif.steps[1].tool_calls![0].extra = { outcome: "abandoned", started_at: "2026-01-01T00:00:00Z", ended_at: "2026-01-01T00:00:01Z" };
    input.context.timeout_policy = { threshold_ms: 1000 };
    const a = await result(input);
    input.atif.session_id = "unrelated";
    input.atif.agent.name = "unrelated";
    input.atif.steps[1].tool_calls![0].extra = { outcome: "abandoned", started_at: "2030-04-05T23:59:59Z", ended_at: "2030-04-06T00:00:00Z" };
    expect(await result(input)).toEqual(a);
  });
  it("keeps a proven timeout even if other calls/evidence are incomplete", async () => {
    const input = await base();
    input.context.completeness = "partial";
    input.atif.steps[1].tool_calls!.push({ tool_call_id: "unknown", function_name: "query", arguments: {} });
    expect(await result(input)).toMatchObject({ state: "completed", observed: true });
  });
  it("exposes first-class pure TypeScript authoring with the same contract", async () => {
    const input = await base();
    const evaluation = await evaluateElement(
      {
        id: "beh-timeout",
        kind: "deterministic",
        evaluate: () => ({ state: "completed", observed: false })
      },
      input
    );
    expect(evaluation).toMatchObject({ implementation: "deterministic", result: { state: "completed", observed: false } });
  });
});
