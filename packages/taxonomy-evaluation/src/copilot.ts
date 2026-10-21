// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CopilotClient } from "@github/copilot-sdk";
import type { AxAIService, AxAIServiceOptions, AxChatRequest, AxChatResponse, AxSerializedOptimizedProgram } from "@ax-llm/ax";
import type { ElementId, TaxonomyInput } from "./contracts.js";
import type { PromptExecutor } from "./engine.js";
import { CallLedger } from "./ledger.js";
import { createSkippedProgram, promptEvidence, OBSERVATION_CONTRACT } from "./prompt.js";
import { executeSdkCall } from "./sdk-call.js";

export { CallLedger } from "./ledger.js";
export { createSkippedProgram, promptEvidence } from "./prompt.js";
export const DEFAULT_MODEL = "gpt-5.6-sol-fast";

export interface CopilotTransport {
  complete(system: string, user: string, signal?: AbortSignal): Promise<{ content: string; usage?: Record<string, unknown> }>;
  close(): Promise<void>;
}

export async function openCopilotTransport(
  ledger: CallLedger, model: string, purpose: string,
): Promise<CopilotTransport> {
  const token = process.env.COPILOT_GITHUB_TOKEN;
  if (!token) throw new Error("COPILOT_GITHUB_TOKEN is required for prompt execution (no logged-in-user fallback)");
  await ledger.events();
  const dir = await mkdtemp(join(tmpdir(), "taxonome-sdk-"));
  const client = new CopilotClient({
    mode: "empty", gitHubToken: token, useLoggedInUser: false, baseDirectory: dir, workingDirectory: dir,
    logLevel: "error", env: { PATH: process.env.PATH, HOME: dir, TMPDIR: process.env.TMPDIR },
  });
  try {
    await client.start();
    if (!(await client.getAuthStatus()).isAuthenticated) throw new Error("Copilot SDK token authentication failed");
  } catch (error) {
    await client.stop();
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
  let failed = false;
  return {
    async complete(system, user, signal) {
      if (failed) throw new Error("Previous SDK call failed; reconcile the ledger before another live invocation");
      const session = await client.createSession({
        model, reasoningEffort: "low", availableTools: [], tools: [], mcpServers: {},
        skillDirectories: [], pluginDirectories: [], instructionDirectories: [], customAgents: [],
        skipCustomInstructions: true, enableConfigDiscovery: false, enableSkills: false, enableFileHooks: false,
        enableHostGitOperations: false, enableSessionStore: false, enableOnDemandInstructionDiscovery: false,
        enableSessionTelemetry: false, skipEmbeddingRetrieval: true, embeddingCacheStorage: "in-memory",
        infiniteSessions: { enabled: false },
        systemMessage: { mode: "replace", content: system },
        onPermissionRequest: () => ({ kind: "denied-by-rules", rules: [] }),
        hooks: { onErrorOccurred: () => ({ errorHandling: "abort", retryCount: 0 }) },
      });
      try { return await executeSdkCall(session, ledger, model, purpose, user, () => client.deleteSession(session.sessionId), signal); }
      catch (error) { failed = true; throw error; }
    },
    async close() { await client.stop(); await rm(dir, { recursive: true, force: true }); },
  };
}

/** Ax's public provider interface; every student/teacher request uses this SDK transport. */
export function copilotAI(transport: CopilotTransport, model = DEFAULT_MODEL, systemPrefix = OBSERVATION_CONTRACT): AxAIService {
  let options: AxAIServiceOptions = { stream: false, debug: false };
  const samples: number[] = [];
  let errors = 0;
  return {
    getId: () => "taxonome-copilot-sdk",
    getName: () => "GitHub Copilot SDK",
    getModelList: () => undefined,
    getFeatures: () => ({
      functions: false, functionEmulation: false, streaming: false, structuredOutputs: false,
      caching: { supported: false, types: [] }, thinking: false, multiTurn: true,
      media: {
        images: { supported: false, formats: [] }, audio: { supported: false, formats: [] },
        files: { supported: false, formats: [], uploadMethod: "none" },
        urls: { supported: false, webSearch: false, contextFetching: false },
      },
    }),
    getMetrics: () => ({
      latency: { chat: { mean: samples.length ? samples.reduce((a, b) => a + b, 0) / samples.length : 0, p95: 0, p99: 0, samples }, embed: { mean: 0, p95: 0, p99: 0, samples: [] } },
      errors: { chat: { count: errors, rate: samples.length ? errors / samples.length : 0, total: samples.length }, embed: { count: 0, rate: 0, total: 0 } },
    }),
    getLogger: () => () => {},
    getLastUsedChatModel: () => model, getLastUsedEmbedModel: () => undefined, getLastUsedModelConfig: () => ({}),
    getEstimatedCost: () => Number.NaN,
    setOptions: value => { options = value; }, getOptions: () => options,
    embed: async () => { throw new Error("Embeddings are not supported"); },
    transcribe: async () => { throw new Error("Transcription is not supported"); },
    speak: async () => { throw new Error("Speech is not supported"); },
    async chat(request: Readonly<AxChatRequest>, callOptions?: Readonly<AxAIServiceOptions>): Promise<AxChatResponse> {
      if (callOptions?.stream) throw new Error("Streaming is not supported by the one-call SDK adapter");
      if (request.functions?.length || request.chatPrompt.some(m => m.role === "function" || (m.role === "assistant" && m.functionCalls?.length))) {
        throw new Error("Taxonome's SDK provider does not allow tools");
      }
      const system: string[] = [], messages: string[] = [];
      for (const message of request.chatPrompt) {
        if (message.role === "system") system.push(message.content);
        else {
          if (message.role === "function" || typeof message.content !== "string") throw new Error("Only text messages are supported");
          messages.push(`<${message.role}>\n${message.content}\n</${message.role}>`);
        }
      }
      const started = Date.now();
      try {
        const result = await transport.complete([systemPrefix, ...system].filter(Boolean).join("\n\n"), messages.join("\n\n"), callOptions?.abortSignal ?? options.abortSignal);
        return { results: [{ index: 0, content: result.content, finishReason: "stop" }] };
      } catch (error) { errors++; throw error; }
      finally { samples.push(Date.now() - started); }
    },
  };
}
export function skippedExecutor(ai: AxAIService, artifact?: AxSerializedOptimizedProgram): PromptExecutor {
  const program = createSkippedProgram(artifact);
  return {
    async evaluate(id: ElementId, input: TaxonomyInput) {
      if (id !== "beh-skipped-invocation") throw new Error("Unsupported prompt element");
      const result = await program.forward(ai, { evidence: promptEvidence(input) }, { maxRetries: 0, maxSteps: 1, stream: false });
      return result.observation;
    },
  };
}
