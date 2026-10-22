// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { z } from "zod";
import {
  defineTaxonomePlugin,
  type DeterministicHandler,
  type HandlerConfigSchema,
} from "taxonomy-evaluation/plugins";

interface RetryConfig {
  /** Minimum explicit attempt count that qualifies as a retry. */
  min_attempts: number;
}

const retryConfigSchema: HandlerConfigSchema<RetryConfig> = z.object({
  min_attempts: z.number().int().min(2).default(2),
}).strict();

/**
 * Detects a recovered retry sequence from explicit Scope call-response evidence.
 *
 * @param input - Frozen normalized ATIF plus loaded taxonomy.
 * @param config - YAML policy; `min_attempts` is the minimum observed attempts.
 */
const retryHandler: DeterministicHandler<RetryConfig> = {
  configSchema: retryConfigSchema,
  evaluate(input, config) {
    // Index declared sources so occurrences copy only grounded source metadata.
    const sources = new Map(
      (input.atif.extra?.scope?.available_sources ?? [])
        .map(source => [source.id, source]),
    );
    const occurrences: unknown[] = [];

    // Accept only explicit structured retry evidence from tool-call responses.
    for (const step of input.atif.steps) {
      for (const call of step.tool_calls ?? []) {
        const response = call.extra?.scope?.response;
        if (
          !response ||
          typeof response !== "object" ||
          Array.isArray(response)
        ) {
          continue;
        }
        const details = response as {
          attempts?: unknown;
          recovered?: unknown;
        };
        if (
          details.recovered !== true ||
          typeof details.attempts !== "number" ||
          details.attempts < config.min_attempts
        ) {
          continue;
        }

        const sourceId = call.extra?.scope?.source_id;
        const source = sourceId ? sources.get(sourceId) : undefined;
        occurrences.push({
          ...(source ? { source } : {}),
          related_turns: [step.step_id],
          tool_call_id: call.tool_call_id,
          ...(call.extra?.scope?.origin
            ? {
              origin: {
                iteration: call.extra.scope.origin.iteration,
                step_id: step.extra?.scope?.origin?.step_id ?? step.step_id,
                tool_call_id: call.extra.scope.origin.tool_call_id,
              },
            }
            : {}),
          attempts: details.attempts,
        });
      }
    }

    // Completed absence is valid because this handler examines every normalized call.
    return occurrences.length
      ? { state: "completed", observed: true, occurrences }
      : { state: "completed", observed: false };
  },
};

export const taxonomePlugin = defineTaxonomePlugin({
  api_version: "scope/taxonome-plugin/v1",
  provider: {
    name: "taxonome-custom-handler-example",
    version: "1.0.0",
  },
  handlers: {
    "acme/retry-loop-v1": retryHandler,
  },
});
