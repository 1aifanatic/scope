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
  optimizer_options: z.record(z.unknown()).optional(),
  transport_settings: z.object({ reasoning_effort: z.literal("low"), sampling: z.literal("sdk-managed"), ax_sampling_hints_applied: z.literal(false) }).strict().optional(),
  optimized: serializedSchema,
  metric_trace: z.array(z.object({ case_id: z.string(), score: z.number(), errors: z.array(z.string()), prediction: z.unknown() }).strict()),
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
  const selected = cases.filter(c => c.elements.includes("beh-skipped-invocation") &&
    c.input.context.completeness === "complete" && c.input.context.applicability?.["beh-skipped-invocation"] !== false &&
    (c.input.context.scenario?.task || c.input.atif.steps.some(s => s.source === "user" && s.message.trim())));
  const train = selected.filter(c => c.split === "train"), validation = selected.filter(c => c.split === "validation");
  if (!train.length || !validation.length) throw new Error("Optimization requires disjoint train and validation cases");
  const lookup = new Map([...train, ...validation].map(c => [promptEvidence(c.input), c]));
  for (const row of train) if (validation.some(v => v.family === row.family || v.originating_run === row.originating_run)) throw new Error("Train/validation family or originating-run leakage");
  const trace: OptimizationArtifact["metric_trace"] = [];
  const example = (c: EvaluationCase) => {
    const expected = gold[c.id]?.["beh-skipped-invocation"];
    if (!expected) throw new Error(`Missing gold for ${c.id}`);
    let observation: unknown;
    if (expected.state === "completed" && expected.observed) {
      observation = {
        state: "completed", observed: true,
        occurrences: expected.occurrences?.map(o => ({
          source: c.input.context.sources.find(s => s.id === o.source_id),
          extension_point: o.extension_point_contains, discovery_turn: o.discovery_turn,
        })),
      };
    } else if (expected.state === "completed") observation = { state: "completed", observed: false };
    else observation = { state: expected.state, reason: expected.state === "indeterminate" ? "Run evidence is incomplete or its completeness is unknown." : "Explicitly excluded assessment." };
    return { evidence: promptEvidence(c.input), observation: skippedResultSchema.parse(observation) };
  };
  const program = createSkippedProgram();
  const optimizerOptions = {
    maxMetricCalls, maxIterations: 2, earlyStoppingPatience: 2, skipPerfectScore: false,
    bootstrap: { maxRounds: 1, maxExamples: train.length, maxDemos: 2, batchSize: 1, dynamicTemperature: false, adaptiveBatching: false },
    seed: 42, verbose: false,
  };
  const optimized = await optimize(program, train.map(example), ({ prediction, example: raw }) => {
    const ex = z.object({ evidence: z.string() }).passthrough().parse(raw);
    const row = lookup.get(ex.evidence);
    if (!row) throw new Error("Optimizer attempted to score an unregistered case");
    let errors: string[];
    try {
      const p = z.object({ observation: skippedResultSchema }).passthrough().parse(prediction);
      const result = validateResult("beh-skipped-invocation", p.observation, row.input);
      errors = assertObservation(result, gold[row.id]["beh-skipped-invocation"]!);
    } catch (error) { errors = [error instanceof Error ? error.message : String(error)]; }
    const score = errors.length ? 0 : 1;
    trace.push({ case_id: row.id, score, errors, prediction });
    return score;
  }, {
    studentAI, teacherAI, validationExamples: validation.map(c => ({ evidence: promptEvidence(c.input) })),
    ...optimizerOptions, logger: () => {}, optimizerLogger: () => {},
  });
  if (!optimized.optimizedProgram) throw new Error("Ax did not return a serializable optimized program");
  return {
    format: "taxonome.ax.v1", schema_version: SCHEMA_VERSION, ax_version: "25.3.2", sdk_version: "1.0.1",
    model, contract_hash: contractHash(), corpus_hash: hash({ train, validation, gold: Object.fromEntries([...train, ...validation].map(c => [c.id, gold[c.id]])) }),
    train_ids: train.map(c => c.id), validation_ids: validation.map(c => c.id),
    settings: { maxMetricCalls, seed: 42, bootstrap: true },
    optimizer_options: optimizerOptions,
    transport_settings: { reasoning_effort: "low", sampling: "sdk-managed", ax_sampling_hints_applied: false },
    optimized: axSerializeOptimizedProgram(optimized.optimizedProgram),
    metric_trace: trace,
  };
}
