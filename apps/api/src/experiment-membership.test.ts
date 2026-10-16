// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Collection } from "mongodb";
import {
  EXPERIMENT_STORAGE_PROFILE_VERSION,
  ExperimentStore,
  fingerprintExperimentPayload,
  type ExperimentDocument,
  type ExperimentExecutionHistoryDocument,
  type ExperimentRequestState,
  type RequestDocument,
} from "shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ExperimentMembershipCoordinator,
  ExperimentMembershipError,
} from "./experiment-membership.js";

const now = new Date("2026-10-16T00:00:00.000Z");
const request = (
  requestId: string,
  runId: string,
): ExperimentRequestState => ({
  requestId,
  runId,
  dependencies: [],
  blockers: [],
});

function experiment(requests: ExperimentRequestState[]): ExperimentDocument {
  const fingerprint = fingerprintExperimentPayload(requests);
  return {
    _id: "experiment-1",
    experimentId: "experiment-1",
    projectId: "project-1",
    metadata: { name: "Experiment" },
    storageProfileVersion: EXPERIMENT_STORAGE_PROFILE_VERSION,
    stateVersion: 1,
    revision: {
      experimentRevisionId: "revision-1",
      revisionNumber: 1,
      memberCount: requests.length,
      membershipFingerprint: fingerprint,
      definitionFingerprint: "definition-1",
      createdAt: now,
    },
    execution: {
      experimentExecutionId: "execution-1",
      attemptNumber: 1,
      version: 1,
      requests: {
        storage: "inline",
        entryCount: requests.length,
        payloadFingerprint: fingerprint,
        payloadVersion: 1,
        entries: requests,
      },
      vectorFingerprint: fingerprint,
      handlerSummary: {},
      blocking: [],
      createdAt: now,
      updatedAt: now,
    },
    createdAt: now,
    updatedAt: now,
    finalizedAt: now,
  };
}

function coordinator(): ExperimentMembershipCoordinator {
  return new ExperimentMembershipCoordinator({
    requests: {} as Collection<RequestDocument>,
    experiments: {} as Collection<ExperimentDocument>,
    executions: {} as Collection<ExperimentExecutionHistoryDocument>,
    chunks: {} as Collection,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ExperimentMembershipCoordinator complete-set operations", () => {
  it("adds several requests through one complete-set replacement", async () => {
    const current = experiment([request("request-1", "run-1")]);
    vi.spyOn(ExperimentStore.prototype, "get").mockResolvedValue(current);
    vi.spyOn(
      ExperimentStore.prototype,
      "readExecutionRequests",
    ).mockResolvedValue([request("request-1", "run-1")]);
    const membership = coordinator();
    const replace = vi.spyOn(membership, "replace").mockResolvedValue({
      experiment: current,
      attachedRequestIds: ["request-2", "request-3"],
      detachedRequestIds: [],
    });

    await membership.add({
      projectId: "project-1",
      experimentId: "experiment-1",
      expectedExperimentRevisionId: "revision-1",
      requestIds: ["request-3", "request-2"],
    });

    expect(replace).toHaveBeenCalledOnce();
    expect(replace).toHaveBeenCalledWith({
      projectId: "project-1",
      experimentId: "experiment-1",
      expectedExperimentRevisionId: "revision-1",
      requestIds: ["request-1", "request-2", "request-3"],
    });
  });

  it("removes the final member through one visible empty revision", async () => {
    const current = experiment([request("request-1", "run-1")]);
    vi.spyOn(ExperimentStore.prototype, "get").mockResolvedValue(current);
    vi.spyOn(
      ExperimentStore.prototype,
      "readExecutionRequests",
    ).mockResolvedValue([request("request-1", "run-1")]);
    const membership = coordinator();
    const replace = vi.spyOn(membership, "replace").mockResolvedValue({
      experiment: current,
      attachedRequestIds: [],
      detachedRequestIds: ["request-1"],
    });

    await membership.remove({
      projectId: "project-1",
      experimentId: "experiment-1",
      expectedExperimentRevisionId: "revision-1",
      requestIds: ["request-1"],
    });

    expect(replace).toHaveBeenCalledWith({
      projectId: "project-1",
      experimentId: "experiment-1",
      expectedExperimentRevisionId: "revision-1",
      requestIds: [],
    });
  });

  it("reports exact request and owner conflicts for duplicate attachment", async () => {
    const current = experiment([request("request-1", "run-1")]);
    vi.spyOn(ExperimentStore.prototype, "get").mockResolvedValue(current);
    vi.spyOn(
      ExperimentStore.prototype,
      "readExecutionRequests",
    ).mockResolvedValue([request("request-1", "run-1")]);

    await expect(
      coordinator().add({
        projectId: "project-1",
        experimentId: "experiment-1",
        expectedExperimentRevisionId: "revision-1",
        requestIds: ["request-1"],
      }),
    ).rejects.toMatchObject<Partial<ExperimentMembershipError>>({
      status: 409,
      code: "request-selection-conflict",
      conflicts: [{
        requestId: "request-1",
        experimentId: "experiment-1",
      }],
    });
  });

  it("rejects a stale expected revision before planning membership", async () => {
    vi.spyOn(ExperimentStore.prototype, "get").mockResolvedValue(
      experiment([request("request-1", "run-1")]),
    );

    await expect(
      coordinator().remove({
        projectId: "project-1",
        experimentId: "experiment-1",
        expectedExperimentRevisionId: "stale-revision",
        requestIds: ["request-1"],
      }),
    ).rejects.toMatchObject<Partial<ExperimentMembershipError>>({
      status: 409,
      code: "stale-experiment-revision",
    });
  });
});
