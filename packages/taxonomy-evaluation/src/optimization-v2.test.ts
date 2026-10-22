// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it } from "vitest";
import { createBuiltInHandlerRegistry } from "./handlers.js";
import {
  OPTIMIZATION_ARTIFACT_VERSION,
  promptContractHash,
  restoreOptimizationArtifactV2,
  semanticHash,
} from "./optimization-v2.js";
import { loadTaxonomy } from "./taxonomy.js";

async function loadProductionTaxonomy() {
  return loadTaxonomy(
    new URL("../taxonomies/agent-behavior/taxonomy.yaml", import.meta.url).pathname,
    { handlers: createBuiltInHandlerRegistry() },
  );
}

describe("v2 optimization artifact compatibility", () => {
  it("rejects historical artifacts instead of silently reinterpreting them", async () => {
    const taxonomy = await loadProductionTaxonomy();

    expect(() => restoreOptimizationArtifactV2(
      { format: "taxonome.ax.v1" },
      taxonomy,
      "beh-skipped-invocation",
      "gpt-4.1",
    )).toThrow(/incompatible/);
  });

  it("restores only an exact taxonomy, element, model, and prompt contract", async () => {
    const taxonomy = await loadProductionTaxonomy();
    const element = taxonomy.elementById.get("beh-skipped-invocation")!;
    const artifact = {
      format: OPTIMIZATION_ARTIFACT_VERSION,
      taxonomy: {
        schema_version: taxonomy.schema_version,
        id: taxonomy.id,
        version: taxonomy.version,
        digest: taxonomy.digest,
      },
      element_id: element.id,
      contract_hash: promptContractHash(taxonomy, element),
      corpus_hash: semanticHash(["case-a", "case-b"]),
      model: "gpt-4.1",
      ax_version: "25.3.2",
      sdk_version: "1.0.1",
      train_ids: ["case-a"],
      validation_ids: ["case-b"],
      settings: { maxMetricCalls: 48, seed: 42, bootstrap: true },
      transport_settings: {
        reasoning_effort: "low",
        sampling: "sdk-managed",
        ax_sampling_hints_applied: false,
      },
      optimized: {
        bestScore: 1,
        stats: {},
        optimizerType: "GEPA",
        optimizationTime: 1,
        totalRounds: 1,
        converged: true,
        instruction: "Preserved learned instruction.",
        demos: [{ evidence: "case-a" }],
      },
      metric_trace: [],
    };

    expect(restoreOptimizationArtifactV2(
      artifact,
      taxonomy,
      element.id,
      "gpt-4.1",
    ).optimized).toMatchObject({
      instruction: "Preserved learned instruction.",
      demos: [{ evidence: "case-a" }],
    });
    expect(() => restoreOptimizationArtifactV2(
      artifact,
      taxonomy,
      element.id,
      "gpt-4.1-mini",
    )).toThrow(/mismatch/);
    expect(() => restoreOptimizationArtifactV2(
      { ...artifact, contract_hash: "tampered" },
      taxonomy,
      element.id,
      "gpt-4.1",
    )).toThrow(/mismatch/);
  });
});
