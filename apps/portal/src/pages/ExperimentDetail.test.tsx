// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExperimentExecutionView, ExperimentView } from "@/lib/experiments";
import type { Report } from "@/types";

const apiMocks = vi.hoisted(() => ({
  getExperiment: vi.fn(),
  listExperimentExecutions: vi.fn(),
  getExperimentExecution: vi.fn(),
  listExperimentReports: vi.fn(),
  retryExperiment: vi.fn(),
  experimentReportStructuredUrl: vi.fn(
    () => "/api/v1/experiments/experiment-1/executions/execution-1/reports/report-1/structured?projectId=project-1",
  ),
}));

vi.mock("@/lib/api", () => ({ api: apiMocks }));

import { ExperimentDetail } from "./ExperimentDetail";

const execution = (
  experimentExecutionId: string,
  attemptNumber: number,
): ExperimentExecutionView => ({
  experimentExecutionId,
  attemptNumber,
  requestCount: 1,
  requests: [{
    requestId: `request-${attemptNumber}`,
    runId: `run-${attemptNumber}`,
    status: "done",
    outcome: "failed",
  }],
  handlerProgress: {
    "pp-readout": { status: "done", version: 1 },
  },
  blocking: [],
  readiness: "done",
  createdAt: `2026-01-0${attemptNumber}T00:00:00.000Z`,
});

const currentExecution = execution("execution-2", 2);
const historicalExecution = execution("execution-1", 1);
const experiment: ExperimentView = {
  experimentId: "experiment-1",
  projectId: "project-1",
  metadata: { name: "Readout experiment" },
  revision: {
    experimentRevisionId: "revision-1",
    revisionNumber: 1,
    memberCount: 1,
  },
  execution: currentExecution,
  readiness: "done",
  blocking: [],
  createdRequestIds: ["request-2"],
  createdAt: "2026-01-01T00:00:00.000Z",
};
const report: Report = {
  _id: "report-1",
  id: "report-1",
  experimentId: "experiment-1",
  experimentExecutionId: "execution-1",
  status: "completed",
  content: "# Historical readout\n\nExact attempt evidence.",
  reporter: {
    id: "pp-readout",
    name: "Experiment Readout",
    gitHash: "abc",
    model: "gpt-5.4",
    agentId: "copilot-sdk",
    agentVersion: "1.0.0",
  },
  structuredArtifact: {
    schemaId: "scope.experiment-readout",
    schemaVersion: "1.0",
    contentType: "application/json",
    url: "reports/report-1/structured.json",
  },
  createdAt: "2026-01-01T01:00:00.000Z",
};

function renderPage(initialEntry: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <Routes>
          <Route path="/experiments/:id" element={<ExperimentDetail />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ExperimentDetail reports", () => {
  it("deep-links to and renders the report for the exact selected execution", async () => {
    apiMocks.getExperiment.mockResolvedValue(experiment);
    apiMocks.listExperimentExecutions.mockResolvedValue({
      items: [currentExecution, historicalExecution],
    });
    apiMocks.getExperimentExecution.mockResolvedValue(historicalExecution);
    apiMocks.listExperimentReports.mockResolvedValue([report]);

    renderPage("/experiments/experiment-1?execution=execution-1");

    expect(
      await screen.findByRole("heading", { name: "Historical readout" }),
    ).toBeDefined();
    expect(apiMocks.getExperimentExecution).toHaveBeenCalledWith(
      "experiment-1",
      "execution-1",
    );
    expect(apiMocks.listExperimentReports).toHaveBeenCalledWith(
      "experiment-1",
      "execution-1",
    );
    expect(
      screen.getByRole("link", { name: "Structured JSON" }).getAttribute("href"),
    ).toContain("/executions/execution-1/reports/report-1/structured");

    let currentAttemptButton: HTMLElement | undefined;
    await waitFor(() => {
      currentAttemptButton = screen
        .getAllByRole("button")
        .find((button) => button.textContent?.includes("Attempt 2"));
      expect(currentAttemptButton).toBeDefined();
    });
    fireEvent.click(currentAttemptButton!);
    await waitFor(() => {
      expect(apiMocks.listExperimentReports).toHaveBeenCalledWith(
        "experiment-1",
        "execution-2",
      );
    });
  });

  it("shows report load errors and retries the same exact execution", async () => {
    apiMocks.getExperiment.mockResolvedValue(experiment);
    apiMocks.listExperimentExecutions.mockResolvedValue({
      items: [currentExecution],
    });
    apiMocks.getExperimentExecution.mockResolvedValue(currentExecution);
    apiMocks.listExperimentReports
      .mockRejectedValueOnce(new Error("Report service unavailable"))
      .mockResolvedValueOnce([]);

    renderPage("/experiments/experiment-1?execution=execution-2");

    expect(await screen.findByText("Report service unavailable")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => {
      expect(apiMocks.listExperimentReports).toHaveBeenCalledTimes(2);
    });
    expect(
      await screen.findByText("No built-in report is available for this execution."),
    ).toBeDefined();
  });
});
