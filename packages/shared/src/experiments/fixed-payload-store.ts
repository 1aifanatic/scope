// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Collection, Document } from "mongodb";
import { z } from "zod";
import { selectFixedPayloadLayout } from "./layout.js";
import {
  ExperimentRequestStateSchema,
} from "./schemas.js";
import {
  computeExperimentChunkId,
  fingerprintExperimentPayload,
} from "./routing.js";
import {
  EXPERIMENT_REQUEST_BUCKET_ASSIGNMENT_VERSION,
  EXPERIMENT_STORAGE_PROFILE_VERSION,
  type ExperimentRequestState,
  type FixedPayload,
} from "./types.js";

interface ExperimentChunkDocument {
  _id: string;
  projectId: string;
  experimentId: string;
  kind: "requests";
  ownerId: string;
  generation: number;
  chunkIndex: number;
  bucketCount: number;
  storageProfileVersion: typeof EXPERIMENT_STORAGE_PROFILE_VERSION;
  assignmentVersion: typeof EXPERIMENT_REQUEST_BUCKET_ASSIGNMENT_VERSION;
  payloadFingerprint: string;
  entries: Array<{ position: number; state: ExperimentRequestState }>;
  createdAt: Date;
}

const ExperimentChunkDocumentSchema = z
  .object({
    _id: z.string().min(1),
    projectId: z.string().min(1),
    experimentId: z.string().min(1),
    kind: z.literal("requests"),
    ownerId: z.string().min(1),
    generation: z.number().int().positive(),
    chunkIndex: z.number().int().nonnegative(),
    bucketCount: z.number().int().positive(),
    storageProfileVersion: z.literal(EXPERIMENT_STORAGE_PROFILE_VERSION),
    assignmentVersion: z.literal(
      EXPERIMENT_REQUEST_BUCKET_ASSIGNMENT_VERSION,
    ),
    payloadFingerprint: z.string().min(1),
    entries: z.array(
      z
        .object({
          position: z.number().int().nonnegative(),
          state: ExperimentRequestStateSchema,
        })
        .strict(),
    ),
    createdAt: z.coerce.date(),
  })
  .strict();

export interface FixedPayloadIdentity {
  projectId: string;
  experimentId: string;
  ownerId: string;
  generation: number;
}

function sameChunk(
  left: ExperimentChunkDocument,
  right: ExperimentChunkDocument,
): boolean {
  return (
    left._id === right._id &&
    left.projectId === right.projectId &&
    left.experimentId === right.experimentId &&
    left.kind === right.kind &&
    left.ownerId === right.ownerId &&
    left.generation === right.generation &&
    left.chunkIndex === right.chunkIndex &&
    left.bucketCount === right.bucketCount &&
    left.storageProfileVersion === right.storageProfileVersion &&
    left.assignmentVersion === right.assignmentVersion &&
    left.payloadFingerprint === right.payloadFingerprint &&
    fingerprintExperimentPayload(left.entries) ===
      fingerprintExperimentPayload(right.entries)
  );
}

export class FixedPayloadStore {
  constructor(
    private readonly chunks: Collection<Document>,
  ) {}

  async prepareRequests(input: {
    identity: FixedPayloadIdentity;
    entries: readonly ExperimentRequestState[];
    inlineDocument: (payload: FixedPayload<ExperimentRequestState>) => object;
    now?: Date;
  }): Promise<FixedPayload<ExperimentRequestState>> {
    if (input.identity.generation < 1) {
      throw new Error("Fixed payload generation must be positive");
    }
    const entries = input.entries.map((entry) =>
      ExperimentRequestStateSchema.parse(entry),
    );
    const payloadFingerprint = fingerprintExperimentPayload(entries);
    const positionByRequestId = new Map(
      entries.map((entry, position) => [entry.requestId, position]),
    );
    const layout = selectFixedPayloadLayout({
      entries,
      inlineDocument: (inlineEntries) =>
        input.inlineDocument({
          storage: "inline",
          entryCount: inlineEntries.length,
          payloadFingerprint,
          entries: inlineEntries,
        }),
      chunkDocument: (chunkIndex, bucketCount, bucketEntries) =>
        this.chunkDocument({
          identity: input.identity,
          chunkIndex,
          bucketCount,
          entries: bucketEntries.map((state) => ({
            position: positionByRequestId.get(state.requestId)!,
            state,
          })),
          payloadFingerprint,
          createdAt: input.now ?? new Date(0),
        }),
    });
    if (layout.storage === "inline") {
      return {
        storage: "inline",
        entryCount: entries.length,
        payloadFingerprint,
        entries,
      };
    }

    const createdAt = input.now ?? new Date();
    const documents = layout.buckets.map((bucketEntries, chunkIndex) =>
      this.chunkDocument({
        identity: input.identity,
        chunkIndex,
        bucketCount: layout.bucketCount,
        entries: bucketEntries.map((state) => ({
          position: positionByRequestId.get(state.requestId)!,
          state,
        })),
        payloadFingerprint,
        createdAt,
      }),
    );
    for (const document of documents) {
      await this.chunks.updateOne(
        { _id: document._id } as Document,
        { $setOnInsert: document } as Document,
        { upsert: true },
      );
    }
    await this.assertDocuments(documents);
    return {
      storage: "chunked",
      entryCount: entries.length,
      payloadFingerprint,
      assignmentVersion: EXPERIMENT_REQUEST_BUCKET_ASSIGNMENT_VERSION,
      bucketCount: layout.bucketCount,
      chunkIds: documents.map((document) => document._id),
    };
  }

  async readRequests(
    identity: FixedPayloadIdentity,
    payload: FixedPayload<ExperimentRequestState>,
  ): Promise<ExperimentRequestState[]> {
    if (payload.storage === "inline") {
      const entries = payload.entries.map((entry) =>
        ExperimentRequestStateSchema.parse(entry),
      );
      this.assertPayloadFingerprint(payload, entries);
      return entries;
    }
    const documents: ExperimentChunkDocument[] = [];
    for (const chunkId of payload.chunkIds) {
      const raw: unknown = await this.chunks.findOne({ _id: chunkId } as Document);
      if (!raw) throw new Error(`Missing experiment chunk ${chunkId}`);
      const document = ExperimentChunkDocumentSchema.parse(
        raw,
      ) as ExperimentChunkDocument;
      this.assertIdentity(document, identity, payload);
      documents.push(document);
    }
    documents.sort((left, right) => left.chunkIndex - right.chunkIndex);
    const positioned = documents
      .flatMap((document) => document.entries)
      .sort((left, right) => left.position - right.position);
    if (
      positioned.some((entry, index) => entry.position !== index)
    ) {
      throw new Error("Experiment payload positions are incomplete or duplicated");
    }
    const entries = positioned.map((entry) => entry.state);
    if (entries.length !== payload.entryCount) {
      throw new Error(
        `Experiment payload expected ${payload.entryCount} entries but loaded ${entries.length}`,
      );
    }
    this.assertPayloadFingerprint(payload, entries);
    return entries;
  }

  async verifyCompleteSet(
    identity: FixedPayloadIdentity,
    payload: FixedPayload<ExperimentRequestState>,
  ): Promise<void> {
    await this.readRequests(identity, payload);
  }

  async discardUnpublished(
    payload: FixedPayload<ExperimentRequestState>,
  ): Promise<number> {
    if (payload.storage === "inline") return 0;
    const result = await this.chunks.deleteMany({
      _id: { $in: payload.chunkIds },
    } as Document);
    return result.deletedCount;
  }

  private chunkDocument(input: {
    identity: FixedPayloadIdentity;
    chunkIndex: number;
    bucketCount: number;
    entries: Array<{ position: number; state: ExperimentRequestState }>;
    payloadFingerprint: string;
    createdAt: Date;
  }): ExperimentChunkDocument {
    return {
      _id: computeExperimentChunkId({
        ...input.identity,
        kind: "requests",
        chunkIndex: input.chunkIndex,
      }),
      ...input.identity,
      kind: "requests",
      chunkIndex: input.chunkIndex,
      bucketCount: input.bucketCount,
      storageProfileVersion: EXPERIMENT_STORAGE_PROFILE_VERSION,
      assignmentVersion: EXPERIMENT_REQUEST_BUCKET_ASSIGNMENT_VERSION,
      payloadFingerprint: input.payloadFingerprint,
      entries: input.entries,
      createdAt: input.createdAt,
    };
  }

  private async assertDocuments(
    expected: ExperimentChunkDocument[],
  ): Promise<void> {
    for (const expectedDocument of expected) {
      const raw: unknown = await this.chunks.findOne({
        _id: expectedDocument._id,
      } as Document);
      if (!raw) {
        throw new Error(
          `Experiment chunk ${expectedDocument._id} was not persisted`,
        );
      }
      const actual = ExperimentChunkDocumentSchema.parse(
        raw,
      ) as ExperimentChunkDocument;
      if (!sameChunk(actual, expectedDocument)) {
        throw new Error(
          `Experiment chunk ${expectedDocument._id} identity or content mismatch`,
        );
      }
    }
  }

  private assertIdentity(
    document: ExperimentChunkDocument,
    identity: FixedPayloadIdentity,
    payload: Extract<FixedPayload<ExperimentRequestState>, { storage: "chunked" }>,
  ): void {
    const expectedId = computeExperimentChunkId({
      ...identity,
      kind: "requests",
      chunkIndex: document.chunkIndex,
    });
    if (
      document._id !== expectedId ||
      document.projectId !== identity.projectId ||
      document.experimentId !== identity.experimentId ||
      document.ownerId !== identity.ownerId ||
      document.generation !== identity.generation ||
      document.bucketCount !== payload.bucketCount ||
      document.assignmentVersion !== payload.assignmentVersion ||
      document.payloadFingerprint !== payload.payloadFingerprint
    ) {
      throw new Error(`Experiment chunk ${document._id} identity mismatch`);
    }
  }

  private assertPayloadFingerprint(
    payload: FixedPayload<ExperimentRequestState>,
    entries: ExperimentRequestState[],
  ): void {
    if (
      fingerprintExperimentPayload(entries) !== payload.payloadFingerprint
    ) {
      throw new Error("Experiment payload fingerprint mismatch");
    }
  }
}
