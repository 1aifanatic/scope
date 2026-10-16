// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
import type { Report } from "@/types";
import { ExperimentReportCard } from "./ExperimentReportCard";

const report: Report = {
  _id: "report-1",
  id: "report-1",
  experimentId: "experiment-1",
  experimentExecutionId: "execution-2",
  status: "completed",
  content: "# Experiment readout\n\nFive exact-vector runs were analyzed.",
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
  createdAt: "2026-01-02T00:00:00.000Z",
};

const meta = {
  title: "Experiments/Reports",
  component: ExperimentReportCard,
  args: {
    experimentId: "experiment-1",
    experimentExecutionId: "execution-2",
    attemptNumber: 2,
    report,
    structuredUrl: "/structured.json",
  },
  parameters: { layout: "padded" },
} satisfies Meta<typeof ExperimentReportCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Completed: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("heading", { name: "Experiment readout" }),
    ).toBeVisible();
    await expect(
      canvas.getByRole("link", { name: "Structured JSON" }),
    ).toBeVisible();
    await expect(canvas.queryByRole("tab")).toBeNull();
  },
};

export const Processing: Story = {
  args: {
    report: undefined,
    structuredUrl: undefined,
    isProcessing: true,
  },
};

export const ErrorWithRetry: Story = {
  args: {
    report: undefined,
    structuredUrl: undefined,
    error: "Report service unavailable",
    onRetry: () => undefined,
  },
};
