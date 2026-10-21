// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import {
  SCHEMA_VERSION,
  prepareInput,
  validateResult,
  type ElementId,
  type Evaluation,
  type Observation,
  type TaxonomyInput,
} from "./contracts.js";
import { detectTimeout } from "./timeout.js";

export interface DeterministicDefinition {
  /** Stable registered element ID whose result schema will validate the output. */
  id: ElementId;
  /** Discriminator proving execution requires no prompt transport. */
  kind: "deterministic";
  /**
   * Evaluates a frozen prepared input.
   *
   * @param input - Validated private input; implementations must not perform hidden I/O.
   */
  evaluate(input: TaxonomyInput): Observation;
}

export interface PromptDefinition {
  /** Stable registered element ID evaluated by the supplied prompt executor. */
  id: ElementId;
  /** Discriminator selecting prompt-backed execution. */
  kind: "prompt";
}

/** Registered definition for either supported execution strategy. */
export type ElementDefinition = DeterministicDefinition | PromptDefinition;

export interface PromptExecutor {
  /**
   * Runs one prompt-backed element.
   *
   * @param id - Prompt element to evaluate.
   * @param input - Frozen prepared evidence supplied to the typed program.
   * @returns Untrusted output that the engine validates before returning.
   */
  evaluate(id: ElementId, input: TaxonomyInput): Promise<unknown>;
}

export const definitions = [
  { id: "beh-skipped-invocation", kind: "prompt" },
  { id: "beh-timeout", kind: "deterministic", evaluate: detectTimeout },
] satisfies ElementDefinition[];

export const behaviorMetadata = {
  "beh-skipped-invocation": { label: "Skipped Invocation", category_id: "behavior-category-invocation" },
  "beh-timeout": { label: "Timeout", category_id: "behavior-category-invocation" },
} as const;

/**
 * Recursively freezes the validated private copy that implementations receive.
 *
 * @param value - Any nested value in the prepared input graph.
 */
function deepFreeze(value: unknown): void {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
  }
}

/**
 * Validates and freezes a private input copy before dispatch.
 * Invalid inputs throw; detector, transport and result failures become error observations.
 *
 * @param definition - Registered execution strategy and element identity.
 * @param value - Untrusted input boundary value.
 * @param executor - Required only for eligible prompt-backed execution.
 * @returns One validated evaluation envelope.
 */
export async function evaluateElement(
  definition: ElementDefinition,
  value: unknown,
  executor?: PromptExecutor,
): Promise<Evaluation> {
  const input = prepareInput(value);
  deepFreeze(input);

  // Metadata preflights must not initialize a prompt executor or guess missing evidence.
  let result: Observation;
  const applicable = input.context.applicability?.[definition.id];
  if (applicable === false) {
    result = { state: "inapplicable", reason: "Element is explicitly outside this scenario's assessment." };
  } else if (definition.id === "beh-skipped-invocation" && input.context.completeness !== "complete") {
    result = {
      state: "indeterminate",
      reason: "Skipped Invocation requires complete post-discovery run evidence to establish non-use."
    };
  } else if (
    definition.id === "beh-skipped-invocation" &&
    !input.context.scenario?.task &&
    !input.atif.steps.some(step => step.source === "user" && step.message.trim())
  ) {
    result = {
      state: "indeterminate",
      reason: "Task context is missing; discovery relevance cannot be assessed."
    };
  } else {
    try {
      if (definition.kind === "deterministic") {
        result = validateResult(definition.id, definition.evaluate(input), input);
      } else {
        if (!executor) {
          throw new Error("Prompt execution requires an explicit prompt executor");
        }

        result = validateResult(definition.id, await executor.evaluate(definition.id, input), input);
      }
    } catch (error) {
      const message = error instanceof AggregateError
        ? `${error.message}: ${error.errors.map(cause => cause instanceof Error ? cause.message : String(cause)).join("; ")}`
        : error instanceof Error ? error.message : String(error);
      result = { state: "error", error: message };
    }
  }

  return {
    schema_version: SCHEMA_VERSION,
    element_id: definition.id,
    implementation: definition.kind,
    result
  };
}

/**
 * Evaluates unique selections in caller order without batching or sharing model calls.
 *
 * @param value - Untrusted input boundary value shared by selected elements.
 * @param ids - Non-empty unique element IDs, preserved in caller order.
 * @param executor - Optional prompt executor; deterministic-only selections do not use it.
 * @returns One evaluation for every requested ID.
 */
export async function evaluate(
  value: unknown,
  ids: readonly ElementId[],
  executor?: PromptExecutor,
): Promise<Evaluation[]> {
  prepareInput(value);
  if (new Set(ids).size !== ids.length || !ids.length) {
    throw new Error("Choose a nonempty, unique element selection");
  }

  const results: Evaluation[] = [];
  for (const id of ids) {
    const definition = definitions.find(candidate => candidate.id === id);
    if (!definition) {
      throw new Error(`Unknown element: ${id}`);
    }

    results.push(await evaluateElement(definition, value, executor));
  }

  return results;
}
