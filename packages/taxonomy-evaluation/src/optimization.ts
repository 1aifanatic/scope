// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { createHash } from "node:crypto";
import { axSerializeOptimizedProgram, optimize, type AxAIService, type AxSerializedOptimizedProgram } from "@ax-llm/ax";
import { z } from "zod";
import { SCHEMA_VERSION, skippedResultSchema, validateResult } from "./contracts.js";
import { assertObservation, type EvaluationCase, type Gold } from "./cases.js";
import { createSkippedProgram, promptEvidence, OBSERVATION_CONTRACT, SKIPPED_INSTRUCTIONS } from "./prompt.js";

export const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const contractHash = () => hash({ SCHEMA_VERSION, OBSERVATION_CONTRACT, SKIPPED_INSTRUCTIONS });

// Validate the Ax public serialization boundary; preserve all learned components.
const serializedSchema = z.custom<AxSerializedOptimizedProgram>(value => {
  const schema = z.object({
    bestScore: z.number(), stats: z.object({}).passthrough(),
    optimizerType: z.string(), optimizationTime: z.number(), totalRounds: z.number(), converged: z.boolean(),
    componentMap: z.record(z.string()).optional(), demos: z.array(z.object({}).passthrough()).optional(),
  }).passthrough();
  return schema.safeParse(value).success;
});
export const artifactSchema = z.object({
  format: z.literal("taxonome.ax.v1"), schema_version: z.literal(SCHEMA_VERSION),
  ax_version: z.literal("25.3.2"), sdk_version: z.literal("1.0.1"),
  model: z.string().min(1), contract_hash: z.string(), corpus_hash: z.string(),
  train_ids: z.array(z.string()), validation_ids: z.array(z.string()),
  settings: z.object({ maxMetricCalls: z.number(), seed: z.number(), bootstrap: z.boolean() }).strict(),
  optimized: serializedSchema,
}).strict();
export type OptimizationArtifact = z.infer<typeof artifactSchema>;
export function restoreArtifact(value: unknown, model: string): OptimizationArtifact {
  const artifact = artifactSchema.parse(value);
  if (artifact.model !== model || artifact.contract_hash !== contractHash()) throw new Error("Optimization artifact model/contract mismatch; establish a new baseline");
  return artifact;
}
export async function optimizeSkipped(
  cases: readonly EvaluationCase[], gold: Gold, studentAI: AxAIService, teacherAI: AxAIService, model: string,
  maxMetricCalls = 48,
): Promise<OptimizationArtifact> {
  const selected = cases.filter(c => c.elements.includes("beh-skipped-invocation"));
  const train = selected.filter(c => c.split === "train"), validation = selected.filter(c => c.split === "validation");
  if (!train.length || !validation.length) throw new Error("Optimization requires disjoint train and validation cases");
  const lookup = new Map(selected.map(c => [promptEvidence(c.input), c]));
  const example = (c: EvaluationCase) => {
    const expected = gold[c.id]?.["beh-skipped-invocation"];
    if (!expected) throw new Error(`Missing gold for ${c.id}`);
    // Gold stays in the metric lookup, never in the program input.
    return { evidence: promptEvidence(c.input) };
  };
  const program = createSkippedProgram();
  const optimized = await optimize(program, train.map(example), ({ prediction, example: raw }) => {
    const ex = z.object({ evidence: z.string() }).passthrough().parse(raw);
    const row = lookup.get(ex.evidence);
    if (!row) throw new Error("Optimizer attempted to score an unregistered case");
    try {
      const p = z.object({ observation: skippedResultSchema }).passthrough().parse(prediction);
      const result = validateResult("beh-skipped-invocation", p.observation, row.input);
      return assertObservation(result, gold[row.id]["beh-skipped-invocation"]!).length ? 0 : 1;
    } catch { return 0; }
  }, {
    studentAI, teacherAI, validationExamples: validation.map(example),
    maxMetricCalls, maxIterations: 2, earlyStoppingPatience: 2, skipPerfectScore: false,
    bootstrap: { maxRounds: 1, maxExamples: train.length, maxDemos: 2, batchSize: 1, dynamicTemperature: false, adaptiveBatching: false },
    seed: 42, verbose: false, logger: () => {}, optimizerLogger: () => {},
  });
  if (!optimized.optimizedProgram) throw new Error("Ax did not return a serializable optimized program");
  return {
    format: "taxonome.ax.v1", schema_version: SCHEMA_VERSION, ax_version: "25.3.2", sdk_version: "1.0.1",
    model, contract_hash: contractHash(), corpus_hash: hash({ train, validation, gold: Object.fromEntries([...train, ...validation].map(c => [c.id, gold[c.id]])) }),
    train_ids: train.map(c => c.id), validation_ids: validation.map(c => c.id),
    settings: { maxMetricCalls, seed: 42, bootstrap: true },
    optimized: axSerializeOptimizedProgram(optimized.optimizedProgram),
  };
}
