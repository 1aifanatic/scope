// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it, vi } from "vitest";
import type { CopilotSession, SessionEvent } from "@github/copilot-sdk";
import { copilotAI, skippedExecutor } from "./copilot.js";
import { executeSdkCall } from "./sdk-call.js";
import { loadCases } from "./cases.js";
import { fileURLToPath } from "node:url";
import { OBSERVATION_CONTRACT, SKIPPED_INSTRUCTIONS } from "./prompt.js";

function fixture() {
  const session: Pick<CopilotSession, "on" | "sendAndWait" | "abort" | "disconnect" | "sessionId"> = {
    sessionId: "mock",
    on: vi.fn(() => () => {}),
    sendAndWait: vi.fn(async () => undefined),
    abort: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
  };
  const ledger = { reserve: vi.fn(async () => 1), finish: vi.fn(async () => {}) };
  const deleted = vi.fn(async () => {});
  return { session, ledger, deleted };
}
describe("Ax custom SDK provider contract (offline)", () => {
  it("uses the actual typed program/parser and fixed wrapper with exactly one request", async () => {
    const complete = vi.fn(async (_system: string, _user: string, _signal?: AbortSignal) => ({ content: 'Observation: {"state":"completed","observed":false}' }));
    const ai = copilotAI({ complete, close: async () => {} });
    const input = (await loadCases(fileURLToPath(new URL("../fixtures/inputs.jsonl", import.meta.url)))).find(c => c.id === "train-none")!.input;
    expect(await skippedExecutor(ai).evaluate("beh-skipped-invocation", input)).toEqual({ state: "completed", observed: false });
    expect(complete).toHaveBeenCalledTimes(1);
    const [system, user] = complete.mock.calls[0];
    expect(system.startsWith(OBSERVATION_CONTRACT)).toBe(true);
    expect(system).toContain(SKIPPED_INSTRUCTIONS);
    expect(user).toContain(input.atif.session_id);
    expect(user).not.toContain("expected");
    expect(ai.getFeatures().functions).toBe(false);
  });
  it("does not repair malformed output or silently substitute providers", async () => {
    const complete = vi.fn(async () => ({ content: "not valid Ax output" }));
    const ai = copilotAI({ complete, close: async () => {} });
    const input = (await loadCases(fileURLToPath(new URL("../fixtures/inputs.jsonl", import.meta.url))))[0].input;
    await expect(skippedExecutor(ai).evaluate("beh-skipped-invocation", input)).rejects.toThrow();
    expect(complete).toHaveBeenCalledTimes(1);
  });
  it("forwards cancellation and rejects unsupported tools/streaming", async () => {
    const complete = vi.fn(async (_system: string, _user: string, _signal?: AbortSignal) => ({ content: "ok" }));
    const ai = copilotAI({ complete, close: async () => {} });
    const controller = new AbortController();
    await ai.chat({ chatPrompt: [{ role: "user", content: "data" }] }, { abortSignal: controller.signal });
    expect(complete.mock.calls[0]?.[2]).toBe(controller.signal);
    await expect(ai.chat({ chatPrompt: [], functions: [{ name: "tool", description: "" }] })).rejects.toThrow("tools");
    await expect(ai.chat({ chatPrompt: [] }, { stream: true })).rejects.toThrow("Streaming");
  });
});
describe("SDK lifecycle failures (offline)", () => {
  it("still disconnects/deletes when ledger completion fails, preserving both errors", async () => {
    const { session, ledger, deleted } = fixture();
    vi.mocked(session.sendAndWait).mockRejectedValue(new Error("primary inference failure"));
    ledger.finish.mockRejectedValue(new Error("ledger I/O failure"));
    const failure: unknown = await executeSdkCall(session, ledger, "mock", "test", "input", deleted).catch(e => e);
    expect(failure).toBeInstanceOf(AggregateError);
    if (failure instanceof AggregateError) expect(failure.errors.map((e: Error) => e.message)).toEqual(["primary inference failure", "ledger I/O failure"]);
    expect(session.abort).toHaveBeenCalled(); expect(session.disconnect).toHaveBeenCalledOnce(); expect(deleted).toHaveBeenCalledOnce();
  });
  it("aborts on caller cancellation and timeout, then accounts and cleans up", async () => {
    for (const cancelled of [true, false]) {
      const { session, ledger, deleted } = fixture();
      vi.mocked(session.sendAndWait).mockImplementation(() => new Promise(() => {}));
      const controller = new AbortController();
      const promise = executeSdkCall(session, ledger, "mock", "test", "input", deleted, controller.signal, 10);
      if (cancelled) setTimeout(() => controller.abort(), 1);
      await expect(promise).rejects.toThrow(cancelled ? "cancelled" : "timed out");
      expect(session.abort).toHaveBeenCalled(); expect(ledger.reserve).toHaveBeenCalledOnce(); expect(ledger.finish).toHaveBeenCalledOnce();
      expect(session.disconnect).toHaveBeenCalledOnce(); expect(deleted).toHaveBeenCalledOnce();
    }
  });
  it("never sends after budget exhaustion or pre-cancellation", async () => {
    const { session, ledger, deleted } = fixture();
    ledger.reserve.mockRejectedValue(new Error("budget exhausted"));
    await expect(executeSdkCall(session, ledger, "mock", "test", "input", deleted)).rejects.toThrow("budget exhausted");
    expect(session.sendAndWait).not.toHaveBeenCalled();
    const controller = new AbortController(); controller.abort();
    await expect(executeSdkCall(session, ledger, "mock", "test", "input", deleted, controller.signal)).rejects.toThrow("cancelled before");
    expect(session.sendAndWait).not.toHaveBeenCalled();
  });
  it("has no unhandled rejection during slow reservation cancellation/timeout", async () => {
    for (const cancelled of [true, false]) {
      const { session, ledger, deleted } = fixture();
      ledger.reserve.mockImplementation(async () => { await new Promise(resolve => setTimeout(resolve, 25)); return 1; });
      const controller = new AbortController();
      const unhandled = vi.fn();
      process.on("unhandledRejection", unhandled);
      try {
        const promise = executeSdkCall(session, ledger, "mock", "test", "input", deleted, controller.signal, cancelled ? 1000 : 5);
        if (cancelled) setTimeout(() => controller.abort(), 1);
        await expect(promise).rejects.toThrow(cancelled ? "cancelled" : "timed out");
        expect(unhandled).not.toHaveBeenCalled(); expect(session.sendAndWait).not.toHaveBeenCalled();
        expect(ledger.finish).toHaveBeenCalledOnce(); expect(deleted).toHaveBeenCalledOnce();
      } finally { process.off("unhandledRejection", unhandled); }
    }
  });
  it("aborts any model failure immediately rather than inviting a runtime retry", async () => {
    const { session, ledger, deleted } = fixture();
    vi.mocked(session.on).mockImplementation(handler => {
      vi.mocked(session.sendAndWait).mockImplementation(async () => {
        handler({ type: "model.call_failure", data: {} } as SessionEvent);
        throw new Error("model failed");
      });
      return () => {};
    });
    await expect(executeSdkCall(session, ledger, "mock", "test", "input", deleted)).rejects.toThrow("model failed");
    expect(session.abort).toHaveBeenCalled();
    expect(ledger.finish).toHaveBeenCalledWith(1, false, expect.any(Number), null, 1);
  });
});
