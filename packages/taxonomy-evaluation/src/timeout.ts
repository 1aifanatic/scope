// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { TaxonomyInput, TimeoutResult } from "./contracts.js";

/**
 * Pure detector over explicit timeout evidence or measured, policy-bounded delays.
 * Incomplete or contradictory evidence cannot prove absence.
 *
 * @param input - Frozen prepared input. `timeout_policy.threshold_ms`, when
 * supplied, is a positive duration in milliseconds.
 * @returns A deterministic observation with zero model calls or hidden I/O.
 */
export function detectTimeout(input: TaxonomyInput): TimeoutResult {
  if (input.context.applicability?.["beh-timeout"] === false) {
    return { state: "inapplicable", reason: "Timeout is explicitly outside this scenario's assessment." };
  }

  const occurrences: Extract<TimeoutResult, { observed: true }>["occurrences"] = [];
  let hasUnknownEvidence = input.context.completeness !== "complete";

  for (const step of input.atif.steps) {
    for (const call of step.tool_calls ?? []) {
      const timing = call.extra;
      const startedAt = timing?.started_at ? Date.parse(timing.started_at) : undefined;
      const endedAt = timing?.ended_at ? Date.parse(timing.ended_at) : undefined;
      const elapsedMs = startedAt !== undefined && endedAt !== undefined ? endedAt - startedAt : undefined;
      const durationMs = timing?.duration_ms ?? elapsedMs;

      // Conflicting measurements stay unknown, even if one also claims a timeout.
      if (
        (elapsedMs !== undefined && elapsedMs < 0) ||
        (elapsedMs !== undefined && timing?.duration_ms !== undefined && Math.abs(elapsedMs - timing.duration_ms) > 1)
      ) {
        hasUnknownEvidence = true;
        continue;
      }

      const policy = input.context.timeout_policy;
      const explicitTimeout = timing?.outcome === "timeout";
      const exceedsPolicy = durationMs !== undefined && policy !== undefined && durationMs >= policy.threshold_ms;
      const interrupted = timing?.progress_interrupted === true || timing?.outcome === "abandoned" || timing?.outcome === "pending";

      if (explicitTimeout || (exceedsPolicy && interrupted)) {
        const source = input.context.sources.find(candidate => candidate.id === timing?.source_id);
        occurrences.push({
          related_turns: [step.step_id],
          tool_call_id: call.tool_call_id,
          ...(source ? { source } : {}),
        });
      } else if (
        durationMs === undefined ||
        !timing?.outcome ||
        timing.outcome === "pending" ||
        (!policy && timing?.progress_interrupted !== false) ||
        (exceedsPolicy && timing?.progress_interrupted === undefined)
      ) {
        hasUnknownEvidence = true;
      }
    }
  }

  // One proven occurrence establishes existence despite other incomplete calls.
  if (occurrences.length) {
    return { state: "completed", observed: true, occurrences };
  }

  if (hasUnknownEvidence) {
    return {
      state: "indeterminate",
      reason: "Complete evidence or reliable call timing/outcome and an applicable delay policy are missing or contradictory."
    };
  }

  return { state: "completed", observed: false };
}
