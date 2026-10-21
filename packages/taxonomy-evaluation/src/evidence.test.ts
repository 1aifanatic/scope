// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { loadCases, loadGold, assertObservation } from "./cases.js";
import { prepareInput, skippedResultSchema, validateResult, atifSchema, contextSchema, SCHEMA_VERSION } from "./contracts.js";
import { copilotAI, skippedExecutor } from "./copilot.js";
import { restoreArtifact, contractHash } from "./optimization.js";
import { buildReadout } from "./readout.js";

const file = (path: string) => fileURLToPath(new URL(`../${path}`, import.meta.url));
const json = async (path: string): Promise<unknown> => JSON.parse(await readFile(file(path), "utf8")) as unknown;
describe("committed real experiment artifacts (offline verification only)", () => {
  it("restores all selected learned demos, which are valid training-only predictions", async () => {
    const artifact = restoreArtifact(await json("evidence/optimized.v2.ax.json"), "gpt-5.6-sol-fast");
    expect(artifact.contract_hash).toBe(contractHash());
    const cases = await loadCases(file("fixtures/inputs.jsonl")), gold = await loadGold(file("fixtures/gold.json"));
    const demos = artifact.optimized.demos?.flatMap(d => d.traces) ?? [];
    expect(demos).toHaveLength(3);
    const seeded = z.object({ examples: z.array(z.unknown()) }).passthrough().parse(artifact.optimized).examples;
    expect(seeded).toHaveLength(5);
    const sessionIds: string[] = [];
    for (const [index, value] of [...demos, ...seeded].entries()) {
      const demo = z.object({ evidence: z.string(), observation: skippedResultSchema }).passthrough().parse(value);
      const input = z.object({ schema_version: z.literal(SCHEMA_VERSION), atif: atifSchema, context: contextSchema }).strict().parse(JSON.parse(demo.evidence) as unknown);
      const row = cases.find(c => c.input.atif.session_id === input.atif.session_id);
      expect(row?.split).toBe("train");
      if (!row) throw new Error("Demo not in training packet");
      expect(validateResult("beh-skipped-invocation", demo.observation, prepareInput({ atif: input.atif, context: input.context }))).toEqual(demo.observation);
      expect(assertObservation(demo.observation, gold[row.id]["beh-skipped-invocation"]!)).toEqual([]);
      if (index < demos.length) sessionIds.push(input.atif.session_id);
    }
    const row = cases.find(c => c.id === "held-cli")!;
    let restoredPrompt = "";
    const executor = skippedExecutor(
      copilotAI({
        complete: async (_system, user) => {
          restoredPrompt = user;
          return { content: 'Observation: {"state":"completed","observed":false}' };
        },
        close: async () => { },
      }),
      artifact.optimized
    );
    await executor.evaluate("beh-skipped-invocation", row.input);
    for (const id of sessionIds) expect(restoredPrompt).toContain(id);
    await expect(json("evidence/optimized.v1.ax.json").then(a => restoreArtifact(a, "gpt-5.6-sol-fast"))).rejects.toThrow("contract mismatch");
  });
  it("keeps the final packet disjoint and unused by the optimizer metric trace", async () => {
    const development = await loadCases(file("fixtures/inputs.jsonl")), final = await loadCases(file("fixtures/final-inputs.jsonl"));
    const artifact = restoreArtifact(await json("evidence/optimized.v2.ax.json"), "gpt-5.6-sol-fast");
    expect(final.every(f => development.every(d => f.family !== d.family && f.originating_run !== d.originating_run))).toBe(true);
    expect(artifact.metric_trace.every(m => final.every(f => f.id !== m.case_id))).toBe(true);
    expect(artifact.metric_trace.every(m => [...artifact.train_ids, ...artifact.validation_ids].includes(m.case_id))).toBe(true);
    expect(artifact.metric_trace.length).toBeLessThanOrEqual(48);
  });
  it("rebuilds the actual-result preview with distinct-run and occurrence counts", async () => {
    const rebuilt = buildReadout(await json("evidence/readout-input.json"));
    expect(rebuilt).toEqual(await json("evidence/readout-preview.json"));
    const timeout = rebuilt.groups[0].behaviors.find(b => b.element_id === "beh-timeout")!;
    expect(timeout.distinct_runs).toBe(2);
    expect(timeout.occurrences).toBe(4);
    expect(timeout.sources.find(s => s.source?.id === "account")).toMatchObject({ distinct_runs: 2, occurrences: 3 });
  });
  it("verifies the frozen ledger, artifact hashes and case packet fingerprints", async () => {
    const manifest = z.object({
      budget: z.object({ cap: z.literal(500), used: z.literal(256), remaining: z.literal(244), finished: z.literal(256) }).passthrough(),
      artifact_sha256: z.record(z.string()),
      case_packet_sha256: z.record(z.string()),
    }).passthrough().parse(await json("evidence/manifest.json"));
    for (const [name, expected] of Object.entries(manifest.artifact_sha256)) {
      expect(name).toMatch(/^[\w.-]+\.(json|jsonl|md)$/);
      expect(createHash("sha256").update(await readFile(file(`evidence/${name}`))).digest("hex")).toBe(expected);
    }
    for (const [name, expected] of Object.entries(manifest.case_packet_sha256)) {
      expect(name).toMatch(/^[\w.-]+\.(json|jsonl)$/);
      expect(createHash("sha256").update(await readFile(file(`fixtures/${name}`))).digest("hex")).toBe(expected);
    }
    const events: unknown[] = (await readFile(file("evidence/call-ledger.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line) as unknown);
    const reservations = events.filter(e => typeof e === "object" && e !== null && "type" in e && e.type === "reserved");
    const finished = events.filter(e => typeof e === "object" && e !== null && "type" in e && e.type === "finished");
    expect(reservations).toHaveLength(256);
    expect(finished).toHaveLength(256);
  });
});
