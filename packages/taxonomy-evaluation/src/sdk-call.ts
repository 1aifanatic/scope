// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { CopilotSession, SessionEvent } from "@github/copilot-sdk";
import type { CallLedger } from "./ledger.js";

type Session = Pick<CopilotSession, "on" | "sendAndWait" | "abort" | "disconnect" | "sessionId">;
type Ledger = Pick<CallLedger, "reserve" | "finish">;
export async function executeSdkCall(
  session: Session, ledger: Ledger, model: string, purpose: string, prompt: string,
  deleteSession: () => Promise<void>, signal?: AbortSignal, timeoutMs = 120_000,
): Promise<{ content: string; usage?: Record<string, unknown> }> {
  const usages: Record<string, unknown>[] = [];
  let attempts = 0, id: number | undefined, ok = false;
  let primary: unknown;
  let output: { content: string; usage?: Record<string, unknown> } | undefined;
  const cleanupErrors: unknown[] = [];
  const started = Date.now();
  const aborts: Promise<void>[] = [];
  const abort = () => { aborts.push(session.abort().catch(error => { cleanupErrors.push(error); })); };
  const off = session.on((event: SessionEvent) => {
    if (event.type === "assistant.usage") {
      attempts++;
      const d = event.data;
      usages.push({
        model: d.model, inputTokens: d.inputTokens, outputTokens: d.outputTokens,
        cacheReadTokens: d.cacheReadTokens, cacheWriteTokens: d.cacheWriteTokens,
        reasoningTokens: d.reasoningTokens, cost: d.cost, duration: d.duration,
      });
    }
    if (event.type === "model.call_failure") { attempts++; abort(); }
  });
  let abortListener: () => void = () => {};
  let stopReason: Error | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stopped = new Promise<Error>(resolve => {
    const onAbort = () => { stopReason = new Error("Copilot SDK request cancelled"); abort(); resolve(stopReason); };
    signal?.addEventListener("abort", onAbort, { once: true });
    abortListener = () => signal?.removeEventListener("abort", onAbort);
    timer = setTimeout(() => {
      stopReason = new Error(`Copilot SDK request timed out after ${timeoutMs}ms`);
      abort(); resolve(stopReason);
    }, timeoutMs);
  });
  try {
    if (signal?.aborted) throw new Error("Copilot SDK request cancelled before submission");
    id = await ledger.reserve(model, purpose);
    if (signal?.aborted) throw new Error("Copilot SDK request cancelled before submission");
    if (stopReason) throw stopReason;
    const response = await Promise.race([session.sendAndWait({ prompt }, timeoutMs), stopped.then(error => { throw error; })]);
    if (!response?.data.content) throw new Error("Copilot SDK returned no assistant content");
    if (attempts > 1) throw new Error("SDK emitted more than one model attempt; single-call contract violated");
    ok = true;
    output = { content: response.data.content, usage: usages[0] };
  } catch (error) { primary = error; abort(); }
  finally {
    clearTimeout(timer);
    abortListener();
    await Promise.all(aborts);
    off();
    if (id !== undefined) {
      // A runtime contract violation must still charge every observed attempt.
      for (let n = 1; n < attempts; n++) {
        try { await ledger.reserve(model, `${purpose}:unexpected-runtime-attempt`); }
        catch (error) { cleanupErrors.push(error); }
      }
      try { await ledger.finish(id, ok, Date.now() - started, usages.length ? { calls: usages } : null, attempts || null); }
      catch (error) { cleanupErrors.push(error); }
    }
    for (const cleanup of [() => session.disconnect(), deleteSession]) {
      try { await cleanup(); } catch (error) { cleanupErrors.push(error); }
    }
  }
  if (primary && !cleanupErrors.length) throw primary;
  if (primary || cleanupErrors.length) throw new AggregateError([...(primary ? [primary] : []), ...cleanupErrors], "Copilot SDK invocation/cleanup failed");
  if (!output) throw new Error("Copilot SDK returned no result");
  return output;
}
