// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Collection, Document } from "mongodb";
import { describe, expect, it } from "vitest";
import { ExperimentStore } from "./experiment-store.js";
import {
  EXPERIMENT_STORAGE_PROFILE_VERSION,
  type ExperimentDocument,
  type ExperimentExecutionHistoryDocument,
} from "./types.js";

function getPath(source: object, path: string): unknown {
  let value: unknown = source;
  for (const segment of path.split(".")) {
    if (typeof value !== "object" || value === null) return undefined;
    value = (value as Record<string, unknown>)[segment];
  }
  return value;
}

function setPath(target: object, path: string, value: unknown): void {
  const segments = path.split(".");
  let current = target as Record<string, unknown>;
  for (const segment of segments.slice(0, -1)) {
    const next = current[segment];
    if (typeof next !== "object" || next === null) {
      current[segment] = {};
    }
    current = current[segment] as Record<string, unknown>;
  }
  current[segments.at(-1)!] = value;
}

function matches(document: object, filter: Document): boolean {
  return Object.entries(filter).every(([path, expected]) => {
    const actual = getPath(document, path);
    if (
      typeof expected === "object" &&
      expected !== null &&
      "$exists" in expected
    ) {
      return (
        (actual !== undefined) ===
        Boolean((expected as { $exists: unknown }).$exists)
      );
    }
    return actual === expected;
  });
}

function atomicCollection(initial: ExperimentDocument) {
  let document = structuredClone(initial);
  return {
    current: () => structuredClone(document),
    async findOne(filter: Document) {
      return matches(document, filter) ? structuredClone(document) : null;
    },
    async findOneAndUpdate(
      filter: Document,
      update: {
        $set?: Record<string, unknown>;
        $inc?: Record<string, number>;
      },
    ) {
      if (!matches(document, filter)) return null;
      const next = structuredClone(document);
      for (const [path, value] of Object.entries(update.$set ?? {})) {
        setPath(next, path, value);
      }
      for (const [path, increment] of Object.entries(update.$inc ?? {})) {
        const value = getPath(next, path);
        if (typeof value !== "number") throw new Error(`Non-number ${path}`);
        setPath(next, path, value + increment);
      }
      document = next;
      return structuredClone(document);
    },
  };
}

function experiment(): ExperimentDocument {
  const now = new Date("2026-01-01T00:00:00.000Z");
  return {
    _id: "experiment-1",
    experimentId: "experiment-1",
    projectId: "project-1",
    metadata: { name: "Experiment" },
    storageProfileVersion: EXPERIMENT_STORAGE_PROFILE_VERSION,
    stateVersion: 2,
    revision: {
      experimentRevisionId: "revision-1",
      revisionNumber: 1,
      memberCount: 1,
      membershipFingerprint: "membership",
      definitionFingerprint: "definition",
      createdAt: now,
    },
    execution: {
      experimentExecutionId: "execution-1",
      attemptNumber: 1,
      version: 1,
      requests: {
        storage: "inline",
        entryCount: 1,
        payloadFingerprint: "payload",
        entries: [
          {
            requestId: "request-1",
            runId: "run-1",
            dependencies: [],
            blockers: [],
          },
        ],
      },
      vectorFingerprint: "vector",
      handlerSummary: {
        report: { status: "queued", version: 1, updatedAt: now },
      },
      blocking: [],
      createdAt: now,
      updatedAt: now,
    },
    createdAt: now,
    updatedAt: now,
    finalizedAt: now,
  };
}

describe("ExperimentStore CAS contracts", () => {
  it("allows exactly one winner in a writer-freezer race", async () => {
    const experiments = atomicCollection(experiment());
    const store = new ExperimentStore({
      experiments:
        experiments as unknown as Collection<ExperimentDocument>,
      executions:
        {} as Collection<ExperimentExecutionHistoryDocument>,
      chunks: {} as Collection,
    });

    const [writer, freezer] = await Promise.all([
      store.claimHandler({
        projectId: "project-1",
        experimentId: "experiment-1",
        experimentExecutionId: "execution-1",
        expectedExecutionVersion: 1,
        handlerId: "report",
        handlerVersion: 1,
      }),
      store.freezeCurrent({
        projectId: "project-1",
        experimentId: "experiment-1",
        experimentExecutionId: "execution-1",
        expectedExecutionVersion: 1,
      }),
    ]);

    expect([writer, freezer].filter(Boolean)).toHaveLength(1);
    expect(experiments.current().execution.version).toBe(2);
    expect(experiments.current().stateVersion).toBe(3);
  });

  it("requires project, execution identity, and version on claims", async () => {
    const experiments = atomicCollection(experiment());
    const store = new ExperimentStore({
      experiments:
        experiments as unknown as Collection<ExperimentDocument>,
      executions:
        {} as Collection<ExperimentExecutionHistoryDocument>,
      chunks: {} as Collection,
    });
    await expect(
      store.claimHandler({
        projectId: "wrong-project",
        experimentId: "experiment-1",
        experimentExecutionId: "execution-1",
        expectedExecutionVersion: 1,
        handlerId: "report",
        handlerVersion: 1,
      }),
    ).resolves.toBeNull();
    await expect(
      store.claimHandler({
        projectId: "project-1",
        experimentId: "experiment-1",
        experimentExecutionId: "wrong-execution",
        expectedExecutionVersion: 1,
        handlerId: "report",
        handlerVersion: 1,
      }),
    ).resolves.toBeNull();
  });
});
