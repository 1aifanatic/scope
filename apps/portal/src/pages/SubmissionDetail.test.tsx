// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Report, Submission } from "@/types";

const submission: Submission = {
  submissionId: "submission-1",
  projectId: "project-1",
  requestIds: ["request-1"],
  createdAt: "2026-01-01T00:00:00.000Z",
  submissionRunId: "submission-run-2",
  attemptNumber: 2,
  readiness: "done",
  requests: [
    {
      requestId: "request-1",
      runId: "run-1",
      task: "Create an API",
      status: "done",
      outcome: "succeeded",
      workerType: "coder-acp-copilot",
    },
  ],
  dependencyProjection: [
    {
      requestId: "request-1",
      runId: "run-1",
      handlerId: "pp-observations",
      state: "ready",
    },
  ],
  blocking: [],
  report: { reportId: "report-1" },
};

const history = {
  runs: [
    {
      _id: "submission-run-2",
      attemptNumber: 2,
      requests: [{ requestId: "request-1", runId: "run-1" }],
      report: { reportId: "report-1" },
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  ],
};

const report: Report = {
  _id: "report-1",
  id: "report-1",
  submissionId: "submission-1",
  submissionRunId: "submission-run-2",
  status: "completed",
  content: "# Generated report",
  structuredArtifact: {
    schemaId: "scope.submission-readout",
    schemaVersion: "1.0",
    contentType: "application/json",
    url: "reports/report-1/structured.json",
  },
  createdAt: "2026-01-01T00:00:00.000Z",
};

vi.mock("@/lib/api", () => ({
  api: {
    getSubmission: vi.fn(async () => submission),
    getSubmissionRuns: vi.fn(async () => history),
    getSubmissionReadout: vi.fn(async () => report),
    retrySubmission: vi.fn(),
    reportStructuredUrl: vi.fn(() => "/api/v1/reports/report-1/structured"),
  },
}));

import { SubmissionDetail } from "./SubmissionDetail";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("SubmissionDetail report terminology", () => {
  it("uses generic report language for the current result and history", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/submissions/submission-1"]}>
          <Routes>
            <Route path="/submissions/:id" element={<SubmissionDetail />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(await screen.findByText("Current report")).toBeDefined();
    expect(screen.getByText("Report generation")).toBeDefined();
    expect(screen.getByText("Report ready")).toBeDefined();
    expect(screen.getByRole("button", { name: "Retry report generation" })).toBeDefined();
    expect(await screen.findByRole("link", { name: "View report" })).toBeDefined();
    expect(screen.queryByText(/readout/i)).toBeNull();
  });
});
