// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { evaluate } from "./engine.js";
import { createBuiltInHandlerRegistry } from "./handlers.js";
import { convertLegacyInput } from "./legacy.js";
import { loadTaxonomy } from "./taxonomy.js";

describe("historical input conversion", () => {
  it("moves context/timing facts into extra.scope without fabricating discoveries", async () => {
    const taxonomy = await loadTaxonomy(
      new URL("../taxonomies/agent-behavior/taxonomy.yaml", import.meta.url).pathname,
      { handlers: createBuiltInHandlerRegistry() },
    );
    const legacy = {
      atif: JSON.parse(await readFile(
        new URL("../fixtures/timeout.atif.json", import.meta.url),
        "utf8",
      )) as unknown,
      context: {
        completeness: "complete",
        sources: [],
      },
    };
    const converted = convertLegacyInput(legacy, taxonomy);

    expect(converted.extra?.scope).toMatchObject({
      schema_version: "scope.atif-extension.v1",
      trajectory_state: "complete",
      available_sources: [],
    });
    expect(converted.steps.every(step =>
      !step.extra?.scope?.discoveries?.length
    )).toBe(true);
    expect(converted.steps[1].tool_calls?.[0].extra?.scope).toMatchObject({
      outcome: "timeout",
      duration_ms: 5000,
    });

    const [evaluation] = await evaluate(
      { atif: converted, taxonomy },
      ["beh-timeout"],
    );
    expect(evaluation.result).toMatchObject({
      state: "completed",
      observed: true,
      occurrences: [{ tool_call_id: "query-1" }],
    });
  });
});
