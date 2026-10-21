// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CopilotClient } from "@github/copilot-sdk";
import type {
  AxAIService,
  AxAIServiceOptions,
  AxChatRequest,
  AxChatResponse,
  AxSerializedOptimizedProgram,
} from "@ax-llm/ax";
import type { ElementId, TaxonomyInput } from "./contracts.js";
import type { PromptExecutor } from "./engine.js";
import { CallLedger } from "./ledger.js";
import { createSkippedProgram, promptEvidence } from "./prompt.js";
import { executeSdkCall } from "./sdk-call.js";

export { CallLedger } from "./ledger.js";
export { createSkippedProgram, promptEvidence } from "./prompt.js";
export const DEFAULT_MODEL = "gpt-5.6-sol-fast";

export interface CopilotTransport {
  complete(
    system: string,
    user: string,
    signal?: AbortSignal,
  ): Promise<{ content: string; usage?: Record<string, unknown> }>;
  close(): Promise<void>;
}

/** Attempts every close independently, preserving a primary failure alongside cleanup failures. */
export async function closeTransports(
  transports: readonly Pick<CopilotTransport, "close">[],
  primary?: unknown,
): Promise<void> {
  const closed = await Promise.allSettled(transports.map(async transport => transport.close()));
  const errors = closed.flatMap(result => result.status === "rejected" ? [result.reason as unknown] : []);

  if (primary !== undefined && !errors.length) {
    throw primary;
  }
  if (primary !== undefined || errors.length) {
    throw new AggregateError([...(primary !== undefined ? [primary] : []), ...errors], "Copilot SDK operation/cleanup failed");
  }
}

/**
 * Opens an isolated, tool-free SDK client using only the explicit environment token.
 * The caller owns close(); a failed submission blocks further calls until reconciliation.
 */
export async function openCopilotTransport(
  ledger: CallLedger,
  model: string,
  purpose: string,
): Promise<CopilotTransport> {
  const token = process.env.COPILOT_GITHUB_TOKEN;
  if (!token) {
    throw new Error("COPILOT_GITHUB_TOKEN is required for prompt execution (no logged-in-user fallback)");
  }

  await ledger.events();
  const sessionDirectory = await mkdtemp(join(tmpdir(), "taxonome-sdk-"));
  const client = new CopilotClient({
    mode: "empty",
    gitHubToken: token,
    useLoggedInUser: false,
    baseDirectory: sessionDirectory,
    workingDirectory: sessionDirectory,
    logLevel: "error",
    env: { PATH: process.env.PATH, HOME: sessionDirectory, TMPDIR: process.env.TMPDIR },
  });

  /** Stops the runtime and removes its isolated home, reporting both failures if needed. */
  async function cleanup() {
    const errors: unknown[] = [];
    try {
      await client.stop();
    } catch (error) {
      errors.push(error);
    }

    try {
      await rm(sessionDirectory, { recursive: true, force: true });
    } catch (error) {
      errors.push(error);
    }

    if (errors.length) {
      throw new AggregateError(errors, "Copilot SDK client cleanup failed");
    }
  }

  try {
    await client.start();
    if (!(await client.getAuthStatus()).isAuthenticated) {
      throw new Error("Copilot SDK token authentication failed");
    }
  } catch (error) {
    try {
      await cleanup();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Copilot SDK initialization and cleanup failed");
    }
    throw error;
  }

  let failed = false;
  return {
    /** Creates one isolated tool-free session and delegates guarded submission/accounting. */
    async complete(system, user, signal) {
      if (failed) {
        throw new Error("Previous SDK call failed; reconcile the ledger before another live invocation");
      }

      const session = await client.createSession({
        // Empty mode plus explicit denials prevents ambient tools, instructions, skills, and storage.
        model,
        reasoningEffort: "low",
        availableTools: [],
        tools: [],
        mcpServers: {},
        skillDirectories: [],
        pluginDirectories: [],
        instructionDirectories: [],
        customAgents: [],
        skipCustomInstructions: true,
        enableConfigDiscovery: false,
        enableSkills: false,
        enableFileHooks: false,
        enableHostGitOperations: false,
        enableSessionStore: false,
        enableOnDemandInstructionDiscovery: false,
        enableSessionTelemetry: false,
        skipEmbeddingRetrieval: true,
        embeddingCacheStorage: "in-memory",
        infiniteSessions: { enabled: false },
        systemMessage: { mode: "replace", content: system },
        onPermissionRequest: () => ({ kind: "denied-by-rules", rules: [] }),
        hooks: { onErrorOccurred: () => ({ errorHandling: "abort", retryCount: 0 }) },
      });

      try {
        return await executeSdkCall(session, ledger, model, purpose, user, () => client.deleteSession(session.sessionId), signal);
      } catch (error) {
        failed = true;
        throw error;
      }
    },
    close: cleanup,
  };
}

/** Ax's public provider interface; every student/teacher request uses this SDK transport. */
export function copilotAI(transport: CopilotTransport, model = DEFAULT_MODEL, systemPrefix = ""): AxAIService {
  let options: AxAIServiceOptions = { stream: false, debug: false };
  const latencySamples: number[] = [];
  let errorCount = 0;
  let warnedAboutSampling = false;

  return {
    // Advertise only capabilities this minimal text-only adapter actually implements.
    getId: () => "taxonome-copilot-sdk",
    getName: () => "GitHub Copilot SDK",
    getModelList: () => undefined,
    getFeatures: () => ({
      functions: false,
      functionEmulation: false,
      streaming: false,
      structuredOutputs: false,
      caching: { supported: false, types: [] },
      thinking: false,
      multiTurn: true,
      media: {
        images: { supported: false, formats: [] },
        audio: { supported: false, formats: [] },
        files: { supported: false, formats: [], uploadMethod: "none" },
        urls: { supported: false, webSearch: false, contextFetching: false },
      },
    }),
    getMetrics: () => ({
      // Ax expects service-level metrics; authoritative per-call usage remains in the durable SDK ledger.
      latency: {
        chat: {
          mean: latencySamples.length ? latencySamples.reduce((total, sample) => total + sample, 0) / latencySamples.length : 0,
          p95: 0,
          p99: 0,
          samples: latencySamples,
        },
        embed: { mean: 0, p95: 0, p99: 0, samples: [] },
      },
      errors: {
        chat: {
          count: errorCount,
          rate: latencySamples.length ? errorCount / latencySamples.length : 0,
          total: latencySamples.length,
        },
        embed: { count: 0, rate: 0, total: 0 },
      },
    }),
    getLogger: () => () => { },
    getLastUsedChatModel: () => model,
    getLastUsedEmbedModel: () => undefined,
    getLastUsedModelConfig: () => ({}),
    getEstimatedCost: () => Number.NaN,
    setOptions: value => {
      options = value;
    },
    getOptions: () => options,
    embed: async () => {
      throw new Error("Embeddings are not supported");
    },
    transcribe: async () => {
      throw new Error("Transcription is not supported");
    },
    speak: async () => {
      throw new Error("Speech is not supported");
    },
    /** Converts one Ax text chat into one SDK completion and normalized Ax usage. */
    async chat(request: Readonly<AxChatRequest>, callOptions?: Readonly<AxAIServiceOptions>): Promise<AxChatResponse> {
      // Reject unsupported features instead of silently degrading Ax's request.
      if (callOptions?.stream ?? options.stream) {
        throw new Error("Streaming is not supported by the one-call SDK adapter");
      }
      if (request.responseFormat) {
        throw new Error("Native structured output is not supported; use the Ax prompt/JSON parser and shared result validator");
      }
      if (request.model && request.model !== model) {
        throw new Error("This SDK adapter is pinned to its configured model");
      }

      if (request.modelConfig && Object.keys(request.modelConfig).length && !warnedAboutSampling) {
        warnedAboutSampling = true;
        process.stderr.write("taxonome: SDK-managed sampling; Ax temperature/token-limit hints cannot be applied by this SDK. Actual settings remain fixed low reasoning; see artifact transport settings.\n");
      }
      if (request.functions?.length || request.chatPrompt.some(message => message.role === "function" || (message.role === "assistant" && message.functionCalls?.length))) {
        throw new Error("Taxonome's SDK provider does not allow tools");
      }
      const system: string[] = [];
      const messages: string[] = [];

      // Preserve roles in a text envelope while installing system messages through the SDK boundary.
      for (const message of request.chatPrompt) {
        if (message.role === "system") {
          system.push(message.content);
        } else {
          if (message.role === "function" || typeof message.content !== "string") {
            throw new Error("Only text messages are supported");
          }
          messages.push(`<${message.role}>\n${message.content}\n</${message.role}>`);
        }
      }

      const startedAt = Date.now();
      try {
        // Each Ax chat maps to exactly one transport completion; Ax retries are disabled by the program.
        const result = await transport.complete(
          [systemPrefix, ...system].filter(Boolean).join("\n\n"),
          messages.join("\n\n"),
          callOptions?.abortSignal ?? options.abortSignal,
        );
        if (typeof result.usage?.model === "string" && result.usage.model !== model) {
          throw new Error("SDK usage reports an unexpected model; no silent model substitution is allowed");
        }

        const inputTokens = result.usage?.inputTokens;
        const outputTokens = result.usage?.outputTokens;
        return {
          results: [{ index: 0, content: result.content, finishReason: "stop" }],
          ...(typeof inputTokens === "number" && typeof outputTokens === "number" ? {
            modelUsage: {
              ai: "GitHub Copilot SDK",
              model,
              tokens: {
                promptTokens: inputTokens,
                completionTokens: outputTokens,
                totalTokens: inputTokens + outputTokens
              },
            },
          } : {}),
        };
      } catch (error) {
        errorCount++;
        throw error;
      } finally {
        latencySamples.push(Date.now() - startedAt);
      }
    },
  };
}

/** Restores optional learned components once and executes only the registered prompt element. */
export function skippedExecutor(ai: AxAIService, artifact?: AxSerializedOptimizedProgram): PromptExecutor {
  const program = createSkippedProgram(artifact);

  return {
    /** Evaluates only Skipped Invocation through the restored one-call program. */
    async evaluate(id: ElementId, input: TaxonomyInput) {
      if (id !== "beh-skipped-invocation") {
        throw new Error("Unsupported prompt element");
      }
      const result = await program.forward(ai, { evidence: promptEvidence(input) }, { maxRetries: 0, maxSteps: 1, stream: false });
      return result.observation;
    },
  };
}
