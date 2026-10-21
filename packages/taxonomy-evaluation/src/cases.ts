// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { elementIdSchema, prepareInput, validateResult, type ElementId, type Evaluation, type Observation, type TaxonomyInput } from "./contracts.js";

export const caseSchema = z.object({
  id: z.string().min(1),
  family: z.string().min(1),
  originating_run: z.string().min(1),
  split: z.enum(["train", "validation", "heldout", "unit"]),
  provenance: z.string().min(1),
  elements: z.array(elementIdSchema).min(1),
  input: z.unknown(),
}).strict();
export interface EvaluationCase extends Omit<z.infer<typeof caseSchema>, "input"> { input: TaxonomyInput }
export const expectationSchema = z.object({
  state: z.enum(["completed", "indeterminate", "inapplicable", "error"]),
  observed: z.boolean().optional(),
  occurrences: z.array(z.object({
    source_id: z.string().optional(),
    discovery_turn: z.number().optional(),
    extension_point_contains: z.string().optional(),
    tool_call_id: z.string().optional(),
    related_turns: z.array(z.number()).optional(),
  }).strict()).optional(),
  exact: z.unknown().optional(),
}).strict();
export type Expectation = z.infer<typeof expectationSchema>;
export const goldSchema = z.record(z.record(elementIdSchema, expectationSchema));
export type Gold = z.infer<typeof goldSchema>;

export async function loadCases(path: string): Promise<EvaluationCase[]> {
  const lines = (await readFile(path, "utf8")).trim().split("\n");
  const cases = lines.map(line => {
    const row = caseSchema.parse(JSON.parse(line) as unknown);
    return { ...row, input: prepareInput(row.input) };
  });
  if (new Set(cases.map(c => c.id)).size !== cases.length) throw new Error("Duplicate case IDs");
  const families = new Map<string, string>(), runs = new Map<string, string>();
  for (const row of cases) {
    for (const [map, key] of [[families, row.family], [runs, row.originating_run]] as const) {
      if (map.has(key) && map.get(key) !== row.split) throw new Error("Originating-run/family leakage between splits");
      map.set(key, row.split);
    }
  }
  return cases;
}
export async function loadGold(path: string): Promise<Gold> {
  return goldSchema.parse(JSON.parse(await readFile(path, "utf8")) as unknown);
}
export function assertObservation(actual: Observation, expected: Expectation): string[] {
  const errors: string[] = [];
  if (actual.state !== expected.state) errors.push(`state expected ${expected.state}, got ${actual.state}`);
  if (expected.observed !== undefined) {
    if (actual.state !== "completed" || actual.observed !== expected.observed) errors.push(`observed expected ${expected.observed}`);
  }
  if (expected.exact !== undefined && !isDeepStrictEqual(actual, expected.exact)) errors.push("Exact JSON mismatch");
  if (expected.occurrences) {
    if (actual.state !== "completed" || !actual.observed) errors.push("Missing positive occurrences");
    else {
      if (actual.occurrences.length !== expected.occurrences.length) errors.push(`Occurrence count expected ${expected.occurrences.length}, got ${actual.occurrences.length}`);
      const remaining = [...actual.occurrences];
      for (const target of expected.occurrences) {
        const index = remaining.findIndex(o =>
          (target.source_id === undefined || o.source?.id === target.source_id) &&
          (target.discovery_turn === undefined || ("discovery_turn" in o && o.discovery_turn === target.discovery_turn)) &&
          (target.extension_point_contains === undefined || ("extension_point" in o && o.extension_point.includes(target.extension_point_contains))) &&
          (target.tool_call_id === undefined || ("tool_call_id" in o && o.tool_call_id === target.tool_call_id)) &&
          (target.related_turns === undefined || ("related_turns" in o && JSON.stringify(o.related_turns) === JSON.stringify(target.related_turns))),
        );
        if (index < 0) errors.push(`Missing grounded occurrence: ${JSON.stringify(target)}`);
        else remaining.splice(index, 1);
      }
    }
  }
  return errors;
}
export function checkCase(row: EvaluationCase, evaluations: readonly Evaluation[], gold: Gold, selection: readonly ElementId[] = row.elements): string[] {
  const errors: string[] = [];
  for (const id of selection) {
    const count = evaluations.filter(e => e.element_id === id).length;
    if (count !== 1) errors.push(`Expected exactly one result for ${id}, got ${count}`);
  }
  for (const e of evaluations) if (!selection.includes(e.element_id)) errors.push(`Unexpected result for ${e.element_id}`);
  for (const evaluation of evaluations) {
    const expected = gold[row.id]?.[evaluation.element_id];
    if (!expected) throw new Error(`Missing gold for ${row.id}/${evaluation.element_id}`);
    try { validateResult(evaluation.element_id, evaluation.result, row.input); }
    catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
    errors.push(...assertObservation(evaluation.result, expected).map(e => `${evaluation.element_id}: ${e}`));
  }
  return errors;
}
