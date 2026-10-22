// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { inputSchema as legacyInputSchema } from "./contracts.js";
import {
  parseScopeAtif,
  SCOPE_ATIF_EXTENSION_VERSION,
  validateScopeAtif,
  type ScopeAtif,
} from "./scope-atif.js";
import type { NormalizedTaxonomy } from "./taxonomy.js";

/**
 * Converts the historical ATIF+context spike input to `extra.scope`.
 *
 * The converter moves declared facts and legacy timing metadata only. It never
 * fabricates discovery events from transcript prose or source availability.
 */
export function convertLegacyInput(
  value: unknown,
  taxonomy: NormalizedTaxonomy,
): ScopeAtif {
  const legacy = legacyInputSchema.parse(value);
  const atif = structuredClone(legacy.atif) as Record<string, unknown>;
  const steps = atif.steps as Array<Record<string, unknown>>;

  for (const step of steps) {
    const calls = step.tool_calls as Array<Record<string, unknown>> | undefined;
    for (const call of calls ?? []) {
      const extra = call.extra && typeof call.extra === "object"
        ? call.extra as Record<string, unknown>
        : {};
      call.extra = {
        scope: {
          origin: undefined,
          source_id: extra.source_id,
          outcome: extra.outcome,
          duration_ms: extra.duration_ms,
          started_at: extra.started_at,
          ended_at: extra.ended_at,
          progress_interrupted: extra.progress_interrupted,
        },
      };
    }
  }

  const context = legacy.context;
  atif.extra = {
    scope: {
      schema_version: SCOPE_ATIF_EXTENSION_VERSION,
      trajectory_state: context.completeness,
      ...(context.scenario?.task ? { task: context.scenario.task } : {}),
      ...(context.run_id || context.scenario || context.profile
        ? {
          run: {
            ...(context.run_id ? { id: context.run_id } : {}),
            ...(context.scenario?.id
              ? { scenario_id: context.scenario.id }
              : {}),
            ...(context.scenario?.label
              ? { scenario_label: context.scenario.label }
              : {}),
            ...(context.profile?.id
              ? { profile_id: context.profile.id }
              : {}),
            ...(context.profile?.label
              ? { profile_label: context.profile.label }
              : {}),
          },
        }
        : {}),
      available_sources: context.sources,
    },
  };

  const converted = parseScopeAtif(atif);
  validateScopeAtif(converted, taxonomy);
  return converted;
}
