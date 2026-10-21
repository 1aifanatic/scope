// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { TaxonomyInput, TimeoutResult } from "./contracts.js";

export function detectTimeout(input: TaxonomyInput): TimeoutResult {
  if (input.context.applicability?.["beh-timeout"] === false) {
    return { state: "inapplicable", reason: "Timeout is explicitly outside this scenario's assessment." };
  }
  const occurrences: Extract<TimeoutResult, { observed: true }>["occurrences"] = [];
  let unknown = input.context.completeness !== "complete";
  for (const step of input.atif.steps) for (const call of step.tool_calls ?? []) {
    const meta = call.extra;
    const start = meta?.started_at ? Date.parse(meta.started_at) : undefined;
    const end = meta?.ended_at ? Date.parse(meta.ended_at) : undefined;
    const elapsed = start !== undefined && end !== undefined ? end - start : undefined;
    const duration = meta?.duration_ms ?? elapsed;
    if ((elapsed !== undefined && elapsed < 0) ||
        (elapsed !== undefined && meta?.duration_ms !== undefined && Math.abs(elapsed - meta.duration_ms) > 1)) {
      unknown = true;
      continue;
    }
    const policy = input.context.timeout_policy;
    const explicit = meta?.outcome === "timeout";
    const delayed = duration !== undefined && policy !== undefined && duration >= policy.threshold_ms;
    const interrupted = meta?.progress_interrupted === true || meta?.outcome === "abandoned" || meta?.outcome === "pending";
    if (explicit || (delayed && interrupted)) {
      const source = input.context.sources.find(s => s.id === meta?.source_id);
      occurrences.push({ related_turns: [step.step_id], tool_call_id: call.tool_call_id, ...(source ? { source } : {}) });
    } else if (duration === undefined || !meta?.outcome || meta.outcome === "pending" ||
        (!policy && meta?.progress_interrupted !== false) || (delayed && meta?.progress_interrupted === undefined)) {
      unknown = true;
    }
  }
  if (occurrences.length) return { state: "completed", observed: true, occurrences };
  if (unknown) return { state: "indeterminate", reason: "Complete evidence or reliable call timing/outcome and an applicable delay policy are missing or contradictory." };
  return { state: "completed", observed: false };
}
