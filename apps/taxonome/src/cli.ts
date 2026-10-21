// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { readFile, writeFile } from "node:fs/promises";
import { Command } from "commander";
import { contextSchema, elementIdSchema, evaluate, loadJson, buildReadout, readoutMarkdown, prepareInput, type ElementId, type Evaluation } from "taxonomy-evaluation";
import { checkCase, loadCases, loadGold } from "taxonomy-evaluation/cases";

interface ModelOptions { model: string; ledger?: string; artifact?: string }
function ids(value: string): ElementId[] { return value.split(",").map(id => elementIdSchema.parse(id)); }
async function runtime(options: ModelOptions, selected: readonly ElementId[], purpose: string) {
  if (!selected.includes("beh-skipped-invocation")) return { executor: undefined, close: async () => {} };
  if (!options.ledger) throw new Error("--ledger is required for all live calls, including eval/optimization/replay");
  const { CallLedger, openCopilotTransport, copilotAI, skippedExecutor } = await import("taxonomy-evaluation/copilot");
  const ledger = new CallLedger(options.ledger);
  await ledger.initialize();
  const { restoreArtifact } = await import("taxonomy-evaluation/optimization");
  const artifact = options.artifact ? restoreArtifact(await loadJson(options.artifact), options.model) : undefined;
  const transport = await openCopilotTransport(ledger, options.model, purpose);
  return { executor: skippedExecutor(copilotAI(transport, options.model), artifact?.optimized), close: () => transport.close() };
}
function modelOptions(command: Command) {
  return command.option("--model <id>", "Copilot model (pinned for comparisons)", "gpt-5.6-sol-fast")
    .option("--ledger <path>", "Shared durable all-in live-call ledger (cap 500)")
    .option("--artifact <path>", "Complete saved Ax optimization artifact");
}
const emit = (value: unknown) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
export function createCli(): Command {
  const cli = new Command().name("taxonome").description("Standalone two-element taxonomy evaluation spike").version("0.1.0");
  cli.configureOutput({ writeOut: s => process.stderr.write(s), writeErr: s => process.stderr.write(s) });
  modelOptions(cli.command("run <atif>").requiredOption("--context <path>", "Explicit evidence context JSON")
    .option("--elements <ids>", "Comma-separated element IDs", "beh-skipped-invocation,beh-timeout"))
    .action(async (atif: string, options: ModelOptions & { context: string; elements: string }) => {
      const input = prepareInput({ atif: await loadJson(atif), context: contextSchema.parse(await loadJson(options.context)) });
      const selected = ids(options.elements), rt = await runtime(options, selected, "run");
      try {
        const results = await evaluate(input, selected, rt.executor);
        emit({ context: input.context, results });
        if (results.some(r => r.result.state === "error")) process.exitCode = 1;
      } finally { await rt.close(); }
    });
  modelOptions(cli.command("eval").requiredOption("--cases <path>", "ATIF/context input JSONL")
    .requiredOption("--gold <path>", "Separate expected JSON/assertions")
    .option("--split <split>", "train, validation, heldout, unit, or all", "heldout")
    .option("--samples <n>", "Repeated independent passes", "1")
    .option("--elements <ids>", "Override case element selection"))
    .action(async (options: ModelOptions & { cases: string; gold: string; split: string; samples: string; elements?: string }) => {
      const all = await loadCases(options.cases), gold = await loadGold(options.gold);
      if (!["train", "validation", "heldout", "unit", "all"].includes(options.split)) throw new Error("Invalid split");
      const cases = all.filter(c => options.split === "all" || c.split === options.split);
      if (!cases.length) throw new Error("No selected cases");
      const count = Number(options.samples);
      if (!Number.isInteger(count) || count < 1 || count > 10) throw new Error("--samples must be 1..10");
      const override = options.elements ? ids(options.elements) : undefined;
      const rt = await runtime(options, override ?? [...new Set(cases.flatMap(c => c.elements))], "eval");
      const rows: { case_id: string; split: string; sample: number; results: Evaluation[]; errors: string[]; latency_ms: number; context: unknown }[] = [];
      try {
        for (let sample = 0; sample < count; sample++) for (const row of cases) {
          const selected = override ?? row.elements;
          for (const id of selected) if (!gold[row.id]?.[id]) throw new Error(`Missing gold for ${row.id}/${id}`);
          const started = Date.now();
          const results = await evaluate(row.input, selected, rt.executor), errors = checkCase(row, results, gold, selected);
          rows.push({ case_id: row.id, split: row.split, sample, results, errors, latency_ms: Date.now() - started, context: row.input.context });
          process.stderr.write(`${row.id} sample=${sample}: ${errors.length ? "FAIL" : "PASS"}\n`);
        }
        const passed = rows.filter(r => !r.errors.length).length;
        emit({ passed, total: rows.length, pass_rate: passed / rows.length, rows });
        if (passed !== rows.length) process.exitCode = 1;
      } finally { await rt.close(); }
    });
  modelOptions(cli.command("optimize").requiredOption("--cases <path>", "Disjoint train/validation/heldout JSONL")
    .requiredOption("--gold <path>", "Fixed assertions")
    .requiredOption("--output <path>", "Complete Ax artifact destination")
    .option("--max-metric-calls <n>", "Finite Ax metric budget, not the all-in ledger cap", "48"))
    .action(async (options: ModelOptions & { cases: string; gold: string; output: string; maxMetricCalls: string }) => {
      if (!options.ledger) throw new Error("--ledger is required for optimization");
      if (options.artifact) throw new Error("Optimization starts from the pinned baseline; --artifact is for run/eval replay");
      const { CallLedger, openCopilotTransport, copilotAI } = await import("taxonomy-evaluation/copilot");
      const { optimizeSkipped } = await import("taxonomy-evaluation/optimization");
      const cases = await loadCases(options.cases), gold = await loadGold(options.gold);
      const max = Number(options.maxMetricCalls);
      if (!Number.isInteger(max) || max < 1 || max > 100) throw new Error("--max-metric-calls must be 1..100");
      const ledger = new CallLedger(options.ledger); await ledger.initialize();
      const student = await openCopilotTransport(ledger, options.model, "optimize:student");
      let teacher: Awaited<ReturnType<typeof openCopilotTransport>> | undefined;
      try {
        teacher = await openCopilotTransport(ledger, options.model, "optimize:teacher");
        const artifact = await optimizeSkipped(cases, gold, copilotAI(student, options.model), copilotAI(teacher, options.model, ""), options.model, max);
        await writeFile(options.output, `${JSON.stringify(artifact, null, 2)}\n`, { flag: "wx" });
        emit({ artifact: options.output, best_score: artifact.optimized.bestScore, budget: await ledger.summary() });
      } finally { await student.close(); await teacher?.close(); }
    });
  cli.command("readout <results>").option("--markdown <path>", "Write Markdown preview (stdout remains JSON)")
    .action(async (path: string, options: { markdown?: string }) => {
      const report = buildReadout(JSON.parse(await readFile(path, "utf8")) as unknown);
      if (options.markdown) await writeFile(options.markdown, readoutMarkdown(report));
      emit(report);
    });
  return cli;
}
