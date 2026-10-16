// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Collection, Document } from "mongodb";
import { describe, expect, it } from "vitest";
import { FixedPayloadStore } from "./fixed-payload-store.js";
import type { ExperimentRequestState } from "./types.js";

function request(index: number): ExperimentRequestState {
  return {
    requestId: `request-${index}`,
    runId: `run-${index}`,
    dependencies: [],
    blockers: [],
  };
}

function chunkCollection(failAt?: number) {
  const documents = new Map<string, Document>();
  let writes = 0;
  return {
    documents,
    async updateOne(
      filter: Document,
      update: { $setOnInsert: Document },
    ) {
      writes += 1;
      if (writes === failAt) throw new Error("injected write failure");
      const id = String(filter._id);
      if (!documents.has(id)) documents.set(id, structuredClone(update.$setOnInsert));
      return { matchedCount: 1, modifiedCount: 1 };
    },
    async findOne(filter: Document) {
      return documents.get(String(filter._id)) ?? null;
    },
    async deleteMany(filter: { _id: { $in: string[] } }) {
      let deletedCount = 0;
      for (const id of filter._id.$in) {
        if (documents.delete(id)) deletedCount += 1;
      }
      return { deletedCount };
    },
  };
}

describe("FixedPayloadStore", () => {
  const identity = {
    projectId: "project-1",
    experimentId: "experiment-1",
    ownerId: "execution-1",
    generation: 1,
  };

  it("has identical logical reads for inline and chunked payloads", async () => {
    const entries = Array.from({ length: 60 }, (_, index) => request(index));
    const collection = chunkCollection();
    const store = new FixedPayloadStore(
      collection as unknown as Collection<Document>,
    );
    const inline = await store.prepareRequests({
      identity,
      entries,
      inlineDocument: (payload) => ({ payload }),
    });
    expect(inline.storage).toBe("inline");
    expect(await store.readRequests(identity, inline)).toEqual(entries);

    const chunked = await store.prepareRequests({
      identity: { ...identity, ownerId: "execution-2", generation: 2 },
      entries,
      inlineDocument: (payload) => ({
        payload,
        padding: "x".repeat(256 * 1024),
      }),
    });
    expect(chunked.storage).toBe("chunked");
    expect(
      await store.readRequests(
        { ...identity, ownerId: "execution-2", generation: 2 },
        chunked,
      ),
    ).toEqual(entries);
  });

  it("fails before returning a publishable descriptor on a partial write", async () => {
    const collection = chunkCollection(2);
    const store = new FixedPayloadStore(
      collection as unknown as Collection<Document>,
    );
    await expect(
      store.prepareRequests({
        identity,
        entries: Array.from({ length: 100 }, (_, index) => ({
          ...request(index),
          dependencies: [
            {
              handlerId: "obs",
              state: "ready",
              error: "x".repeat(1_800),
            },
          ],
        })),
        inlineDocument: (payload) => ({
          payload,
          padding: "x".repeat(256 * 1024),
        }),
      }),
    ).rejects.toThrow("injected write failure");
    expect(collection.documents.size).toBe(1);
  });

  it("rejects deterministic-id identity mismatches", async () => {
    const collection = chunkCollection();
    const store = new FixedPayloadStore(
      collection as unknown as Collection<Document>,
    );
    const payload = await store.prepareRequests({
      identity,
      entries: [request(1)],
      inlineDocument: (value) => ({
        value,
        padding: "x".repeat(256 * 1024),
      }),
    });
    expect(payload.storage).toBe("chunked");
    await expect(
      store.readRequests({ ...identity, projectId: "other-project" }, payload),
    ).rejects.toThrow(/identity mismatch/);
  });
});
