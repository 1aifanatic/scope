// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { readFile, writeFile } from "node:fs/promises";
import { Command } from "commander";
import {
  contextSchema,
  elementIdSchema,
  evaluate,
  loadJson,
  buildReadout,
  readoutMarkdown,
  prepareInput,
  type ElementId,
  type Evaluation,
  type PromptExecutor,
} from "taxonomy-evaluation";
import { checkCase, loadCases, loadGold } from "taxonomy-evaluation/cases";

interface ModelOptions {
  model: string;
  ledger?: string;
  artifact?: string;
}

function parseElementIds(value: string): ElementId[] {
  return value.split(",").map(id => elementIdSchema.parse(id));
}

/** Defers SDK imports/auth until an eligible element actually asks for inference. */
async function createRuntime(options: ModelOptions, selected: readonly ElementId[], purpose: string) {
  if (!selected.includes("beh-skipped-invocation")) {
    if (options.artifact) {
      throw new Error("--artifact requires a prompt element selection");
    }

    return {
      executor: undefined,
      close: async () => { },
      metadata: async () => ({ strategy: "deterministic" })
    };
  }

  let active: {
    executor: PromptExecutor;
    close(): Promise<void>;
    contract_hash: string;
    artifact_hash: string | null;
  } | undefined;
  let starting: Promise<NonNullable<typeof active>> | undefined;

  /** Opens or verifies the one shared cumulative ledger before any prompt request. */
  async function openLedger() {
    if (!options.ledger) {
      throw new Error("--ledger is required for all live calls, including eval/optimization/replay");
    }

    const { CallLedger } = await import("taxonomy-evaluation/ledger");
    const ledger = new CallLedger(options.ledger);
    await ledger.initialize();
    return ledger;
  }

  /** Lazily creates the isolated transport and restores the optional complete artifact. */
  async function start() {
    const ledger = await openLedger();
    const { openCopilotTransport, copilotAI, skippedExecutor } = await import("taxonomy-evaluation/copilot");
    const { restoreArtifact, contractHash, hash } = await import("taxonomy-evaluation/optimization");
    const artifact = options.artifact ? restoreArtifact(await loadJson(options.artifact), options.model) : undefined;
    const transport = await openCopilotTransport(ledger, options.model, purpose);

    try {
      active = {
        executor: skippedExecutor(copilotAI(transport, options.model), artifact?.optimized),
        close: () => transport.close(),
        contract_hash: contractHash(),
        artifact_hash: artifact ? hash(artifact) : null,
      };
    } catch (error) {
      try {
        await transport.close();
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "Prompt initialization and cleanup failed");
      }
      throw error;
    }

    return active;
  }

  return {
    executor: {
      evaluate: async (id, input) => {
        starting ??= start();
        return (await starting).executor.evaluate(id, input);
      },
    } satisfies PromptExecutor,
    close: async () => {
      await active?.close();
    },
    metadata: async () => {
      const snapshot = options.ledger ? await (await openLedger()).summary() : undefined;
      return {
        model: options.model,
        initialized: !!active,
        contract_hash: active?.contract_hash,
        artifact_hash: active?.artifact_hash,
        budget: snapshot ? { cap: snapshot.cap, used: snapshot.used, remaining: snapshot.remaining } : null,
      };
    },
  };
}

function addModelOptions(command: Command) {
  return command.option("--model <id>", "Copilot model (pinned for comparisons)", "gpt-5.6-sol-fast")
    .option(
      "--ledger <path>",
      "Shared durable all-in live-call ledger (cap 500)"
    )
    .option(
      "--artifact <path>",
      "Complete saved Ax optimization artifact"
    );
}

const emit = (value: unknown) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);

/** Configures commands without running them; only JSON results are written to stdout. */
export function createCli(): Command {
  const cli = new Command().name("taxonome").description("Standalone two-element taxonomy evaluation spike").version("0.1.0");
  cli.configureOutput({ writeOut: s => process.stderr.write(s), writeErr: s => process.stderr.write(s) });

  // Run one validated input through the same API used by programmatic callers.
  addModelOptions(cli.command("run <atif>").requiredOption("--context <path>", "Explicit evidence context JSON")
    .option(
      "--elements <ids>",
      "Comma-separated element IDs",
      "beh-skipped-invocation,beh-timeout"
    ))
    .action(async (atif: string, options: ModelOptions & { context: string; elements: string }) => {
      // Acquisition and context validation complete before any runtime is opened.
      const input = prepareInput({ atif: await loadJson(atif), context: contextSchema.parse(await loadJson(options.context)) });
      const selected = parseElementIds(options.elements);
      const runtime = await createRuntime(options, selected, "run");

      try {
        const results = await evaluate(input, selected, runtime.executor);
        emit({ context: input.context, results, metadata: await runtime.metadata() });
        if (results.some(result => result.result.state === "error")) {
          process.exitCode = 1;
        }
      } finally {
        await runtime.close();
      }
    });

  // Evaluate a split repeatedly while keeping expected assertions outside model inputs.
  addModelOptions(cli.command("eval").requiredOption("--cases <path>", "ATIF/context input JSONL")
    .requiredOption(
      "--gold <path>",
      "Separate expected JSON/assertions"
    )
    .option(
      "--split <split>",
      "train, validation, heldout, unit, or all",
      "heldout"
    )
    .option(
      "--samples <n>",
      "Repeated independent passes",
      "1"
    )
    .option(
      "--elements <ids>",
      "Override case element selection"
    ))
    .action(async (options: ModelOptions & { cases: string; gold: string; split: string; samples: string; elements?: string }) => {
      const allCases = await loadCases(options.cases);
      const gold = await loadGold(options.gold);
      if (!["train", "validation", "heldout", "unit", "all"].includes(options.split)) {
        throw new Error("Invalid split");
      }

      const cases = allCases.filter(row => options.split === "all" || row.split === options.split);
      if (!cases.length) {
        throw new Error("No selected cases");
      }

      const sampleCount = Number(options.samples);
      if (!Number.isInteger(sampleCount) || sampleCount < 1 || sampleCount > 10) {
        throw new Error("--samples must be 1..10");
      }

      const override = options.elements ? parseElementIds(options.elements) : undefined;
      const runtime = await createRuntime(options, override ?? [...new Set(cases.flatMap(row => row.elements))], "eval");
      const before = await runtime.metadata();
      const rows: {
        case_id: string;
        split: string;
        sample: number;
        results: Evaluation[];
        errors: string[];
        latency_ms: number;
        context: unknown;
        prompt_predictions: unknown[];
      }[] = [];

      try {
        // Preserve deterministic case/sample order so evidence rows and call accounting are reproducible.
        for (let sample = 0; sample < sampleCount; sample++) {
          for (const row of cases) {
            const selected = override ?? row.elements;
            for (const id of selected) {
              if (!gold[row.id]?.[id]) {
                throw new Error(`Missing gold for ${row.id}/${id}`);
              }
            }

            const startedAt = Date.now();
            const promptPredictions: unknown[] = [];
            const executor = runtime.executor;

            // Preflight results are not model predictions; capture only actual executor output.
            const capturingExecutor: PromptExecutor | undefined = executor ? {
              evaluate: async (id, input) => {
                const prediction = await executor.evaluate(id, input);
                promptPredictions.push({ element_id: id, prediction });
                return prediction;
              },
            } : undefined;
            const results = await evaluate(row.input, selected, capturingExecutor);
            const errors = checkCase(row, results, gold, selected);

            rows.push({
              case_id: row.id,
              split: row.split,
              sample,
              results,
              errors,
              latency_ms: Date.now() - startedAt,
              context: row.input.context,
              prompt_predictions: promptPredictions,
            });
            process.stderr.write(`${row.id} sample=${sample}: ${errors.length ? "FAIL" : "PASS"}\n`);
          }
        }

        // Emit one machine-readable report after all rows and cleanup metadata are available.
        const passed = rows.filter(row => !row.errors.length).length;
        emit({
          passed,
          total: rows.length,
          pass_rate: passed / rows.length,
          metadata: { before, after: await runtime.metadata() },
          rows
        });
        if (passed !== rows.length) {
          process.exitCode = 1;
        }
      } finally {
        await runtime.close();
      }
    });

  // Optimize only the prompt-backed element, using separate SDK transports for student and teacher calls.
  addModelOptions(cli.command("optimize").requiredOption("--cases <path>", "Disjoint train/validation/heldout JSONL")
    .requiredOption(
      "--gold <path>",
      "Fixed assertions"
    )
    .requiredOption(
      "--output <path>",
      "Complete Ax artifact destination"
    )
    .option(
      "--max-metric-calls <n>",
      "Finite Ax metric budget, not the all-in ledger cap",
      "48"
    ))
    .action(async (options: ModelOptions & { cases: string; gold: string; output: string; maxMetricCalls: string }) => {
      if (!options.ledger) {
        throw new Error("--ledger is required for optimization");
      }
      if (options.artifact) {
        throw new Error("Optimization starts from the pinned baseline; --artifact is for run/eval replay");
      }

      const { CallLedger, openCopilotTransport, copilotAI, closeTransports } = await import("taxonomy-evaluation/copilot");
      const { optimizeSkipped } = await import("taxonomy-evaluation/optimization");
      const cases = await loadCases(options.cases);
      const gold = await loadGold(options.gold);
      const maxMetricCalls = Number(options.maxMetricCalls);
      if (!Number.isInteger(maxMetricCalls) || maxMetricCalls < 1 || maxMetricCalls > 100) {
        throw new Error("--max-metric-calls must be 1..100");
      }

      const ledger = new CallLedger(options.ledger);
      await ledger.initialize();
      const student = await openCopilotTransport(ledger, options.model, "optimize:student");
      let teacher: Awaited<ReturnType<typeof openCopilotTransport>> | undefined;
      let failure: unknown;
      let output: unknown;

      try {
        // The complete artifact is written atomically only after Ax returns a selected program.
        teacher = await openCopilotTransport(ledger, options.model, "optimize:teacher");
        const artifact = await optimizeSkipped(
          cases,
          gold,
          copilotAI(student, options.model),
          copilotAI(teacher, options.model, ""),
          options.model,
          maxMetricCalls
        );
        await writeFile(options.output, `${JSON.stringify(artifact, null, 2)}\n`, { flag: "wx" });
        output = {
          artifact: options.output,
          best_score: artifact.optimized.bestScore,
          budget: await ledger.summary()
        };
      } catch (error) {
        failure = error;
      }

      await closeTransports(teacher ? [student, teacher] : [student], failure);
      if (!output) {
        throw new Error("Optimizer returned no artifact");
      }
      emit(output);
    });

  // Convert validated structured results into deterministic JSON and optional Markdown.
  cli.command("readout <results>").option("--markdown <path>", "Write Markdown preview (stdout remains JSON)")
    .action(async (path: string, options: { markdown?: string }) => {
      const report = buildReadout(JSON.parse(await readFile(path, "utf8")) as unknown);
      if (options.markdown) {
        await writeFile(options.markdown, readoutMarkdown(report));
      }
      emit(report);
    });

  return cli;
}
