// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { prepareInput, validateResult } from "taxonomy-evaluation";
import { copilotAI, skippedExecutor, type CopilotTransport } from "taxonomy-evaluation/copilot";

/** JSONL target registry for standalone SDK-only families (not the Azure runner). */
export const standaloneTargets = {
  "taxonome-skipped-invocation/default": {
    family: "taxonome-skipped-invocation",
    variant: "default",
    transport: "copilot-sdk",
    cases: "packages/taxonomy-evaluation/fixtures/inputs.jsonl",
    assertions: "packages/taxonomy-evaluation/fixtures/gold.json",
    async run(input: unknown, transport: CopilotTransport, model: string) {
      const prepared = prepareInput(input);
      const prediction = await skippedExecutor(copilotAI(transport, model)).evaluate("beh-skipped-invocation", prepared);
      return validateResult("beh-skipped-invocation", prediction, prepared);
    },
  },
} as const;
export function listStandaloneTargets() {
  return Object.entries(standaloneTargets).map(([adapterId, target]) => ({
    adapterId, family: target.family, variant: target.variant, transport: target.transport,
  }));
}
