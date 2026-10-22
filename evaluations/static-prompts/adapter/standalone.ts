// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import {
  createBuiltInHandlerRegistry,
  evaluate,
  loadTaxonomy,
  parseScopeAtif,
  validateScopeAtif,
} from "taxonomy-evaluation";
import {
  copilotAI,
  taxonomyPromptExecutor,
  type CopilotTransport,
} from "taxonomy-evaluation/copilot";

const productionTaxonomy = loadTaxonomy(
  new URL(
    "../../../packages/taxonomy-evaluation/taxonomies/agent-behavior/taxonomy.yaml",
    import.meta.url,
  ).pathname,
  { handlers: createBuiltInHandlerRegistry() },
);

/** JSONL target registry for standalone SDK-only families (not the Azure runner). */
export const standaloneTargets = {
  "taxonome-skipped-invocation/default": {
    family: "taxonome-skipped-invocation",
    variant: "default",
    transport: "copilot-sdk",
    cases: "packages/taxonomy-evaluation/fixtures/v2/inputs.jsonl",
    assertions: "packages/taxonomy-evaluation/fixtures/v2/gold.json",
    /**
     * Runs one case through the production Ax/SDK adapter and shared grounding validator.
     *
     * @param input - Untrusted case input.
     * @param transport - Explicit Copilot SDK transport supplied by the standalone runner.
     * @param model - Exact model ID used by the adapter.
     */
    async run(input: unknown, transport: CopilotTransport, model: string) {
      // This adapter loads the production YAML; it has no evaluation-only prompt copy.
      const taxonomy = await productionTaxonomy;
      const atif = parseScopeAtif(input);
      validateScopeAtif(atif, taxonomy);
      const [evaluation] = await evaluate(
        { atif, taxonomy },
        ["beh-skipped-invocation"],
        taxonomyPromptExecutor(copilotAI(transport, model)),
      );
      return evaluation.result;
    },
  },
} as const;

/**
 * Exposes a JSON-safe inventory that the evaluation manifest coverage check can compare exactly.
 *
 * @returns One descriptor per standalone family/variant pair.
 */
export function listStandaloneTargets() {
  return Object.entries(standaloneTargets).map(([adapterId, target]) => ({
    adapterId,
    family: target.family,
    variant: target.variant,
    transport: target.transport,
  }));
}
