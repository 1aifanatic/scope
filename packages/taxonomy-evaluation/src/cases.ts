// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  elementIdSchema,
  prepareInput,
  validateResult,
  type ElementId,
  type LegacyEvaluation,
  type Observation,
  type LegacyTaxonomyInput,
} from "./contracts.js";

/**
 * Validates one curated case row.
 *
 * `id` is unique within the packet; `family` and `originating_run` must not
 * cross splits; `split` controls optimizer/evaluation use; `provenance`
 * distinguishes synthetic/reviewed sources; `elements` is a non-empty
 * selection; and `input` is validated separately by {@link prepareInput}.
 */
export const caseSchema = z.object({
  id: z.string().min(1),
  family: z.string().min(1),
  originating_run: z.string().min(1),
  split: z.enum(["train", "validation", "heldout", "unit"]),
  provenance: z.string().min(1),
  elements: z.array(elementIdSchema).min(1),
  input: z.unknown(),
}).strict();

/**
 * One curated evaluation row.
 *
 * Manifest fields retain family/origin/split provenance, while `input` is
 * replaced with the prepared typed value after loading.
 */
export interface EvaluationCase extends Omit<z.infer<typeof caseSchema>, "input"> {
  /** Validated runtime input; gold expectations remain in a separate file. */
  input: LegacyTaxonomyInput;
}

/**
 * Assertion contract for one element result.
 *
 * `state` is always required; `observed` is optional and meaningful only for
 * completed results; occurrence assertions can constrain source, discovery
 * turn, extension-point substring, call ID, or exact related turns. Omitted
 * occurrence fields are unconstrained. `exact` requests full deep equality;
 * otherwise state/polarity/selected evidence fields are checked.
 */
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

/** Narrowed assertion shape derived from {@link expectationSchema}. */
export type Expectation = z.infer<typeof expectationSchema>;
export const goldSchema = z.record(z.record(elementIdSchema, expectationSchema));

/** Gold assertions keyed by case ID, then element ID. */
export type Gold = z.infer<typeof goldSchema>;

/**
 * Loads separate input rows and rejects IDs or originating families reused across splits.
 *
 * @param path - JSONL path; blank lines are not accepted inside the packet.
 * @returns Prepared cases in file order.
 */
export async function loadCases(path: string): Promise<EvaluationCase[]> {
  const lines = (await readFile(path, "utf8")).trim().split("\n");
  const cases = lines.map(line => {
    const row = caseSchema.parse(JSON.parse(line) as unknown);
    return { ...row, input: prepareInput(row.input) };
  });
  if (new Set(cases.map(row => row.id)).size !== cases.length) {
    throw new Error("Duplicate case IDs");
  }

  const families = new Map<string, string>();
  const runs = new Map<string, string>();

  // Family and originating-run grouping prevents near-duplicate leakage across splits.
  for (const row of cases) {
    for (const [map, key] of [[families, row.family], [runs, row.originating_run]] as const) {
      if (map.has(key) && map.get(key) !== row.split) {
        throw new Error("Originating-run/family leakage between splits");
      }
      map.set(key, row.split);
    }
  }

  return cases;
}

/**
 * Loads the separate gold assertions; expected outputs never enter runtime inputs.
 *
 * @param path - JSON file keyed by case and element IDs.
 */
export async function loadGold(path: string): Promise<Gold> {
  return goldSchema.parse(JSON.parse(await readFile(path, "utf8")) as unknown);
}

/**
 * Returns assertion failures; omitted expectation fields are unconstrained, not absent.
 *
 * @param actual - Validated observation produced by execution.
 * @param expected - Reviewed semantic and evidence assertions.
 * @returns Human-readable failures; an empty array means the observation passed.
 */
export function assertObservation(actual: Observation, expected: Expectation): string[] {
  const errors: string[] = [];

  // State and polarity are independent assertions because only completed results have polarity.
  if (actual.state !== expected.state) {
    errors.push(`state expected ${expected.state}, got ${actual.state}`);
  }

  if (expected.observed !== undefined) {
    if (actual.state !== "completed" || actual.observed !== expected.observed) {
      errors.push(`observed expected ${expected.observed}`);
    }
  }

  if (expected.exact !== undefined && !isDeepStrictEqual(actual, expected.exact)) {
    errors.push("Exact JSON mismatch");
  }

  // Occurrence assertions constrain only fields named by gold and consume matches one-for-one.
  if (expected.occurrences) {
    if (actual.state !== "completed" || !actual.observed) {
      errors.push("Missing positive occurrences");
    } else {
      if (actual.occurrences.length !== expected.occurrences.length) {
        errors.push(`Occurrence count expected ${expected.occurrences.length}, got ${actual.occurrences.length}`);
      }

      // Consume matches so one actual occurrence cannot satisfy multiple gold occurrences.
      const remaining = [...actual.occurrences];
      for (const target of expected.occurrences) {
        const index = remaining.findIndex(occurrence =>
          (target.source_id === undefined || occurrence.source?.id === target.source_id) &&
          (target.discovery_turn === undefined || ("discovery_turn" in occurrence && occurrence.discovery_turn === target.discovery_turn)) &&
          (target.extension_point_contains === undefined || ("extension_point" in occurrence && occurrence.extension_point.includes(target.extension_point_contains))) &&
          (target.tool_call_id === undefined || ("tool_call_id" in occurrence && occurrence.tool_call_id === target.tool_call_id)) &&
          (target.related_turns === undefined || ("related_turns" in occurrence && JSON.stringify(occurrence.related_turns) === JSON.stringify(target.related_turns))),
        );

        if (index < 0) {
          errors.push(`Missing grounded occurrence: ${JSON.stringify(target)}`);
        } else {
          remaining.splice(index, 1);
        }
      }
    }
  }

  return errors;
}

/**
 * Checks selection coverage and grounded gold facts; missing gold is a configuration error.
 *
 * @param row - Curated input/provenance row.
 * @param evaluations - Results returned for this row.
 * @param gold - Separate reviewed assertion map.
 * @param selection - Expected unique element IDs; defaults to the case declaration.
 * @returns All coverage, validation, and semantic assertion failures.
 */
export function checkCase(
  row: EvaluationCase,
  evaluations: readonly LegacyEvaluation[],
  gold: Gold,
  selection: readonly ElementId[] = row.elements,
): string[] {
  const errors: string[] = [];

  // Selection coverage catches missing, duplicate, and unexpected element results before scoring.
  for (const id of selection) {
    const count = evaluations.filter(evaluation => evaluation.element_id === id).length;
    if (count !== 1) {
      errors.push(`Expected exactly one result for ${id}, got ${count}`);
    }
  }

  // Shape/evidence validation and semantic gold assertions report separate diagnostics.
  for (const evaluation of evaluations) {
    if (!selection.includes(evaluation.element_id)) {
      errors.push(`Unexpected result for ${evaluation.element_id}`);
    }
  }

  for (const evaluation of evaluations) {
    const expected = gold[row.id]?.[evaluation.element_id];
    if (!expected) {
      throw new Error(`Missing gold for ${row.id}/${evaluation.element_id}`);
    }

    try {
      validateResult(evaluation.element_id, evaluation.result, row.input);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }

    errors.push(...assertObservation(evaluation.result, expected).map(error => `${evaluation.element_id}: ${error}`));
  }

  return errors;
}
