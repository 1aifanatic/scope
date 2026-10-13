// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  Report,
  Submission,
  SubmissionRunAttempt,
} from "@/types";

const submission: Submission = {
  submissionId: "submission-1",
  projectId: "project-1",
  requestIds: ["request-1", "request-2"],
  createdAt: "2026-01-01T00:00:00.000Z",
  submissionRunId: "submission-run-2",
  attemptNumber: 2,
  readiness: "done",
  requests: [
    {
      requestId: "request-1",
      runId: "run-current-1",
      task: "Create an API",
      status: "done",
      outcome: "succeeded",
      workerType: "coder-acp-copilot",
      model: "gpt-5.4",
    },
    {
      requestId: "request-2",
      runId: "run-current-2",
      task: "Document the API",
      status: "done",
      outcome: "succeeded",
      workerType: "coder-acp-copilot",
      model: "gpt-5.4",
    },
  ],
  dependencyProjection: [
    {
      requestId: "request-1",
      runId: "run-current-1",
      handlerId: "pp-observations",
      state: "ready",
    },
    {
      requestId: "request-2",
      runId: "run-current-2",
      handlerId: "security-scan",
      state: "ready",
    },
  ],
  blocking: [],
  handlerProgress: {
    "pp-readout": { status: "done", version: 1 },
  },
  report: { reportId: "report-current" },
};

const currentAttempt: SubmissionRunAttempt = {
  _id: "submission-run-2",
  attemptNumber: 2,
  vectorFingerprint: "vector-current",
  requests: [
    { requestId: "request-1", runId: "run-current-1" },
    { requestId: "request-2", runId: "run-current-2" },
  ],
  dependencyProjection: submission.dependencyProjection,
  blocking: [],
  handlerStatus: submission.handlerProgress,
  report: { reportId: "report-current" },
  createdAt: "2026-01-02T00:00:00.000Z",
};

const historicalAttempt: SubmissionRunAttempt = {
  _id: "submission-run-1",
  attemptNumber: 1,
  vectorFingerprint: "vector-historical",
  requests: [
    { requestId: "request-1", runId: "run-historical-1" },
    { requestId: "request-2", runId: "run-historical-2" },
  ],
  dependencyProjection: [
    {
      requestId: "request-1",
      runId: "run-historical-1",
      handlerId: "pp-observations",
      state: "ready",
    },
    {
      requestId: "request-2",
      runId: "run-historical-2",
      handlerId: "security-scan",
      state: "ready",
    },
  ],
  blocking: [],
  handlerStatus: {
    "pp-readout": { status: "done", version: 1 },
  },
  report: { reportId: "report-historical" },
  createdAt: "2026-01-01T00:00:00.000Z",
  supersededAt: "2026-01-02T00:00:00.000Z",
  supersededBySubmissionRunId: "submission-run-2",
  supersededReason: "request-vector-changed",
};

const reports: Report[] = [
  {
    _id: "report-current",
    id: "report-current",
    submissionId: "submission-1",
    submissionRunId: "submission-run-2",
    status: "completed",
    content: "# Current generated report",
    reporter: {
      id: "pp-readout",
      name: "Submission Readout",
      gitHash: "abc",
      model: "gpt-5.4",
      agentId: "copilot",
      agentVersion: "1.0.0",
    },
    structuredArtifact: {
      schemaId: "scope.submission-readout",
      schemaVersion: "1.0",
      contentType: "application/json",
      url: "reports/report-current/structured.json",
    },
    createdAt: "2026-01-02T00:00:00.000Z",
  },
  {
    _id: "report-historical",
    id: "report-historical",
    submissionId: "submission-1",
    submissionRunId: "submission-run-1",
    status: "completed",
    content: "# Historical generated report",
    createdAt: "2026-01-01T00:00:00.000Z",
  },
];

vi.mock("@/lib/api", () => ({
  api: {
    getSubmission: vi.fn(async () => submission),
    getSubmissionRuns: vi.fn(async () => ({
      runs: [currentAttempt, historicalAttempt],
    })),
    getSubmissionReports: vi.fn(async () => reports),
    retrySubmission: vi.fn(),
    reportStructuredUrl: vi.fn(
      (id: string) => `/api/v1/reports/${id}/structured`,
    ),
    submissionRunLogsUrl: vi.fn(
      (_id: string, attemptId: string) =>
        `/api/v1/submissions/submission-1/runs/${attemptId}/logs`,
    ),
  },
}));

vi.mock("@/hooks/use-log-stream", () => ({
  useLogStream: vi.fn(() => ({
    logs: [],
    isConnected: false,
    isDone: true,
    error: null,
    clear: vi.fn(),
  })),
}));

import { SubmissionDetail } from "./SubmissionDetail";
import { api } from "@/lib/api";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderDetail(initialEntry = "/submissions/submission-1") {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <Routes>
          <Route path="/submissions/:id" element={<SubmissionDetail />} />
          <Route path="/runs/:id" element={<div>Run detail destination</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("SubmissionDetail", () => {
  it("defaults to Reports and supports multiple current and historical reports", async () => {
    renderDetail();

    expect(
      await screen.findByRole("heading", { name: "Current generated report" }),
    ).toBeDefined();
    expect(
      screen.getByRole("tab", { name: "Reports (2)" }).getAttribute("data-state"),
    ).toBe("active");
    expect(screen.getAllByText("Current").length).toBeGreaterThan(0);
    expect(screen.getByText("Historical")).toBeDefined();
    expect(
      screen.getByRole("link", { name: "Structured JSON" }).getAttribute("href"),
    ).toBe("/api/v1/reports/report-current/structured");

    const historicalReportButton = screen
      .getAllByRole("button")
      .find(
        (button) =>
          button.textContent?.includes("Historical") &&
          button.textContent?.includes("completed"),
      );
    expect(historicalReportButton).toBeDefined();
    await userEvent.click(historicalReportButton!);
    expect(
      await screen.findByRole("heading", {
        name: "Historical generated report",
      }),
    ).toBeDefined();
    expect(
      screen.getByText(/Viewing attempt 1 \(historical and read-only\)/),
    ).toBeDefined();
  });

  it("renders the immutable member vector with the shared table and run navigation", async () => {
    renderDetail();
    await screen.findByRole("heading", { name: "Current generated report" });

    await userEvent.click(screen.getByRole("tab", { name: "Runs (2)" }));

    expect(
      screen.getByRole("heading", { name: "Immutable member run vector" }),
    ).toBeDefined();
    expect(screen.getByRole("columnheader", { name: "Request" })).toBeDefined();
    expect(
      screen.getByRole("columnheader", { name: "Exact run attempt" }),
    ).toBeDefined();
    expect(
      screen.getByRole("columnheader", { name: "Dependencies" }),
    ).toBeDefined();
    const requestLink = screen
      .getAllByRole("link")
      .find((link) => link.getAttribute("href")?.includes("run-current-1"));
    expect(requestLink).toBeDefined();
    expect(requestLink!.getAttribute("href")).toContain(
      "runId=run-current-1",
    );
    expect(requestLink!.getAttribute("href")).toContain(
      "fromSubmission=submission-1",
    );
  });

  it("switches attempts through the picker and scopes Processing to history", async () => {
    renderDetail("/submissions/submission-1?tab=processing");
    await screen.findByText("Report ready");

    const picker = screen.getByRole("combobox", { name: "Submission attempt" });
    await userEvent.click(picker);
    const listbox = await screen.findByRole("listbox");
    await userEvent.click(
      within(listbox).getByText(/Attempt 1 · Superseded/),
    );

    expect(
      await screen.findByText(/Viewing attempt 1 \(historical and read-only\)/),
    ).toBeDefined();
    expect(screen.getByText("Dependencies ready")).toBeDefined();
    expect(screen.getByText("Observations 1/1")).toBeDefined();
    expect(screen.getByText("Security Scan 1/1")).toBeDefined();
    expect(
      screen.getByRole("heading", { name: "Attempt processing logs" }),
    ).toBeDefined();
  });

  it("shows current attempt progress when only historical reports exist", async () => {
    vi.mocked(api.getSubmission).mockResolvedValueOnce({
      ...submission,
      readiness: "processing",
      report: undefined,
      handlerProgress: {
        "pp-readout": { status: "processing", version: 1 },
      },
    });
    vi.mocked(api.getSubmissionRuns).mockResolvedValueOnce({
      runs: [
        {
          ...currentAttempt,
          report: undefined,
          handlerStatus: {
            "pp-readout": { status: "processing", version: 1 },
          },
        },
        historicalAttempt,
      ],
    });
    vi.mocked(api.getSubmissionReports).mockResolvedValueOnce([
      reports[1]!,
    ]);

    renderDetail();

    expect(
      await screen.findByRole("tab", { name: "Reports (1)" }),
    ).toBeDefined();
    expect(screen.getByText("Report not available")).toBeDefined();
    expect(
      screen.getByText("A report is being generated for this attempt."),
    ).toBeDefined();
    expect(screen.getByText("Historical")).toBeDefined();
  });
});
