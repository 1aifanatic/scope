// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { z } from "zod";

export const SCHEMA_VERSION = "taxonome.observation.v1";
export const surfaces = {
  "surface-skills": "Skills",
  "surface-mcp": "MCP",
  "surface-instructions": "Instructions",
  "surface-docs": "Documentation",
  "surface-cli": "CLI",
  "surface-errors": "Errors",
  "surface-auth": "Authentication",
  "surface-base-model": "Base model",
} as const;

export const sourceSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  surface_id: z.enum(Object.keys(surfaces) as [keyof typeof surfaces, ...(keyof typeof surfaces)[]]),
}).strict();
export type Source = z.infer<typeof sourceSchema>;

const turn = z.number().int().positive();
const callSchema = z.object({
  tool_call_id: z.string().min(1),
  function_name: z.string().min(1),
  arguments: z.unknown(),
  extra: z.object({
    duration_ms: z.number().finite().nonnegative().optional(),
    started_at: z.string().datetime({ offset: true }).optional(),
    ended_at: z.string().datetime({ offset: true }).optional(),
    outcome: z.enum(["timeout", "completed", "error", "abandoned", "pending"]).optional(),
    progress_interrupted: z.boolean().optional(),
    source_id: z.string().min(1).optional(),
  }).passthrough().optional(),
}).passthrough();

export const atifSchema = z.object({
  schema_version: z.literal("ATIF-v1.7"),
  session_id: z.string().min(1),
  agent: z.object({ name: z.string().min(1) }).passthrough(),
  steps: z.array(z.object({
    step_id: turn,
    source: z.enum(["system", "user", "agent"]),
    message: z.string(),
    timestamp: z.string().datetime({ offset: true }).optional(),
    tool_calls: z.array(callSchema).optional(),
    observation: z.object({
      results: z.array(z.object({
        source_call_id: z.string().min(1).optional(),
        content: z.unknown(),
      }).passthrough()),
    }).passthrough().optional(),
  }).passthrough()),
}).passthrough();

export const contextSchema = z.object({
  run_id: z.string().min(1).optional(),
  scenario: z.object({ id: z.string().min(1), label: z.string().min(1), task: z.string().min(1).optional() }).strict().optional(),
  profile: z.object({ id: z.string().min(1), label: z.string().min(1) }).strict().optional(),
  completeness: z.enum(["complete", "partial", "unknown"]),
  sources: z.array(sourceSchema),
  timeout_policy: z.object({ threshold_ms: z.number().finite().positive() }).strict().optional(),
  applicability: z.object({
    "beh-skipped-invocation": z.boolean().optional(),
    "beh-timeout": z.boolean().optional(),
  }).strict().optional(),
}).strict();
export const inputSchema = z.object({ atif: atifSchema, context: contextSchema }).strict();
export type TaxonomyInput = z.infer<typeof inputSchema>;
export type Atif = TaxonomyInput["atif"];

export const skippedOccurrenceSchema = z.object({
  extension_point: z.string().min(1),
  source: sourceSchema,
  discovery_turn: turn,
}).strict();
export const timeoutOccurrenceSchema = z.object({
  source: sourceSchema.optional(),
  related_turns: z.array(turn).min(1),
  tool_call_id: z.string().min(1),
}).strict();
const unassessed = z.object({
  state: z.enum(["indeterminate", "inapplicable"]),
  reason: z.string().min(1),
}).strict();
const executionError = z.object({
  state: z.literal("error"),
  error: z.string().min(1),
}).strict();
function observationSchema<T extends z.ZodTypeAny>(occurrence: T) {
  return z.union([
    z.object({
      state: z.literal("completed"),
      observed: z.literal(true),
      occurrences: z.array(occurrence).min(1)
    }).strict(),
    z.object({ state: z.literal("completed"), observed: z.literal(false) }).strict(),
    unassessed,
    executionError,
  ]);
}
export const skippedResultSchema = observationSchema(skippedOccurrenceSchema);
export const timeoutResultSchema = observationSchema(timeoutOccurrenceSchema);
export type SkippedResult = z.infer<typeof skippedResultSchema>;
export type TimeoutResult = z.infer<typeof timeoutResultSchema>;
export type Observation = SkippedResult | TimeoutResult;
export type Occurrence = z.infer<typeof skippedOccurrenceSchema> | z.infer<typeof timeoutOccurrenceSchema>;

/** Identifies one discovery event or call within a single element assessment. */
export function occurrenceIdentity(occurrence: Occurrence): string {
  return "discovery_turn" in occurrence
    ? JSON.stringify([occurrence.source.id, occurrence.discovery_turn, occurrence.extension_point])
    : occurrence.tool_call_id;
}

export const elementIdSchema = z.enum(["beh-skipped-invocation", "beh-timeout"]);
export type ElementId = z.infer<typeof elementIdSchema>;
export const evaluationSchema = z.object({
  schema_version: z.literal(SCHEMA_VERSION),
  element_id: elementIdSchema,
  implementation: z.enum(["prompt", "deterministic"]),
  result: z.unknown(),
}).strict().superRefine((value, ctx) => {
  const parsed = (value.element_id === "beh-timeout" ? timeoutResultSchema : skippedResultSchema).safeParse(value.result);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      ctx.addIssue({ ...issue, path: ["result", ...issue.path] });
    }
  }
});

export interface Evaluation {
  schema_version: typeof SCHEMA_VERSION;
  element_id: ElementId;
  implementation: "prompt" | "deterministic";
  result: Observation;
}

/** Returns a private validated copy, preserving ATIF extensions and rejecting broken references/order. */
export function prepareInput(value: unknown): TaxonomyInput {
  const input = structuredClone(inputSchema.parse(value));
  const stepIds = input.atif.steps.map(step => step.step_id);
  if (new Set(stepIds).size !== stepIds.length || stepIds.some((id, index) => index > 0 && id <= stepIds[index - 1])) {
    throw new Error("ATIF step IDs must be unique and preserve strictly increasing trajectory order");
  }

  const calls = input.atif.steps.flatMap(step => step.tool_calls ?? []);
  const callIds = new Set(calls.map(call => call.tool_call_id));
  if (callIds.size !== calls.length) {
    throw new Error("Duplicate ATIF tool_call_id");
  }

  const sourceIds = new Set(input.context.sources.map(source => source.id));
  if (sourceIds.size !== input.context.sources.length) {
    throw new Error("Duplicate context source id");
  }

  for (const call of calls) {
    if (call.extra?.source_id && !sourceIds.has(call.extra.source_id)) {
      throw new Error("Undeclared call source");
    }
  }

  for (const step of input.atif.steps) {
    for (const result of step.observation?.results ?? []) {
      if (result.source_call_id && !callIds.has(result.source_call_id)) {
        throw new Error("Observation references an unknown tool call");
      }
    }
  }

  return input;
}

/** Validates result shape, assessment preconditions and evidence attribution; throws on violations. */
export function validateResult(id: ElementId, value: unknown, input: TaxonomyInput): Observation {
  const result = (id === "beh-timeout" ? timeoutResultSchema : skippedResultSchema).parse(value);
  if (result.state === "inapplicable" && input.context.applicability?.[id] !== false) {
    throw new Error("Inapplicable requires explicit assessment exclusion, not an irrelevant reference or unmet reference-reading condition");
  }
  if (id === "beh-skipped-invocation" && result.state === "completed" && input.context.completeness !== "complete") {
    throw new Error("Skipped Invocation cannot assert non-use or absence from incomplete run evidence");
  }

  if (result.state !== "completed" || !result.observed) {
    return result;
  }

  const occurrenceIds = new Set<string>();
  for (const occurrence of result.occurrences) {
    if (occurrence.source && !input.context.sources.some(source => JSON.stringify(source) === JSON.stringify(occurrence.source))) {
      throw new Error("Occurrence source is not a supplied typed source");
    }

    const turns = "discovery_turn" in occurrence ? [occurrence.discovery_turn] : occurrence.related_turns;
    if (turns.some(turnId => !input.atif.steps.some(step => step.step_id === turnId))) {
      throw new Error("Ungrounded occurrence turn");
    }

    if ("tool_call_id" in occurrence) {
      const step = input.atif.steps.find(candidate => candidate.tool_calls?.some(call => call.tool_call_id === occurrence.tool_call_id));
      if (!step || !turns.includes(step.step_id)) {
        throw new Error("Ungrounded occurrence call");
      }

      const call = step.tool_calls?.find(candidate => candidate.tool_call_id === occurrence.tool_call_id);
      if (call?.extra?.source_id !== occurrence.source?.id) {
        throw new Error("Call/source attribution mismatch");
      }
    }

    const key = occurrenceIdentity(occurrence);
    if (occurrenceIds.has(key)) {
      throw new Error("Duplicate occurrence");
    }
    occurrenceIds.add(key);
  }

  return result;
}
