// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { mkdir, open, readFile, rmdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";

const headerSchema = z.object({ type: z.literal("budget"), cap: z.number().int().positive().max(500) }).strict();
const eventSchema = z.discriminatedUnion("type", [
  headerSchema,
  z.object({ type: z.literal("reserved"), id: z.number().int().positive(), model: z.string(), purpose: z.string(), at: z.string() }).strict(),
  z.object({
    type: z.literal("finished"), id: z.number().int().positive(), ok: z.boolean(), latency_ms: z.number(),
    usage: z.record(z.unknown()).nullable(), model_attempts: z.number().int().nonnegative().nullable(),
  }).strict(),
]);
export type LedgerEvent = z.infer<typeof eventSchema>;

/** Durable reservations are never refunded, including crashes and failed calls. */
export class CallLedger {
  readonly path: string;
  constructor(path: string) { this.path = resolve(path); }
  private async locked<T>(work: () => Promise<T>): Promise<T> {
    await mkdir(dirname(this.path), { recursive: true });
    const lock = `${this.path}.lock`;
    await mkdir(lock).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "EEXIST") throw new Error("Call ledger is locked; concurrent calls or a crashed owner require explicit reconciliation");
      throw error;
    });
    try { return await work(); } finally { await rmdir(lock); }
  }
  private async append(event: LedgerEvent): Promise<void> {
    const file = await open(this.path, "a", 0o600);
    try { await file.writeFile(`${JSON.stringify(event)}\n`); await file.sync(); } finally { await file.close(); }
  }
  async initialize(cap = 500): Promise<void> {
    headerSchema.parse({ type: "budget", cap });
    await this.locked(async () => {
      try {
        const file = await open(this.path, "wx", 0o600);
        try { await file.writeFile(`${JSON.stringify({ type: "budget", cap })}\n`); await file.sync(); } finally { await file.close(); }
      } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
        const events = await this.events();
        if (events[0]?.type !== "budget" || events[0].cap !== cap) throw new Error("Existing ledger budget cannot be reset or changed");
      }
    });
  }
  async events(): Promise<LedgerEvent[]> {
    const text = await readFile(this.path, "utf8");
    const events = text.trim().split("\n").map(line => eventSchema.parse(JSON.parse(line) as unknown));
    if (events[0]?.type !== "budget" || events.slice(1).some(e => e.type === "budget")) throw new Error("Invalid cumulative ledger header");
    const ids = events.filter(e => e.type === "reserved").map(e => e.id);
    if (ids.some((id, index) => id !== index + 1)) throw new Error("Invalid cumulative ledger sequence");
    return events;
  }
  async reserve(model: string, purpose: string): Promise<number> {
    return this.locked(async () => {
      const events = await this.events();
      const header = headerSchema.parse(events[0]);
      const used = events.filter(e => e.type === "reserved").length;
      if (used >= header.cap) throw new Error(`Live-call budget exhausted (${used}/${header.cap}); no SDK call made`);
      const id = used + 1;
      await this.append({ type: "reserved", id, model, purpose, at: new Date().toISOString() });
      return id;
    });
  }
  async finish(id: number, ok: boolean, latency_ms: number, usage: Record<string, unknown> | null, model_attempts: number | null): Promise<void> {
    await this.locked(async () => {
      const events = await this.events();
      if (!events.some(e => e.type === "reserved" && e.id === id) || events.some(e => e.type === "finished" && e.id === id)) {
        throw new Error("Ledger completion must reference one unfinished reservation");
      }
      await this.append(eventSchema.parse({ type: "finished", id, ok, latency_ms, usage, model_attempts }));
    });
  }
  async summary() {
    const events = await this.events();
    const header = headerSchema.parse(events[0]);
    const used = events.filter(e => e.type === "reserved").length;
    return { cap: header.cap, used, remaining: header.cap - used, events };
  }
}
