// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";

vi.mock("@/lib/api", () => ({
  api: {
    listAgents: vi.fn(async () => []),
    listMcpServers: vi.fn(async () => []),
    listProfiles: vi.fn(async () => []),
    listProfileVersions: vi.fn(async () => []),
    listRuns: vi.fn(async () => ({ data: [] })),
    listModels: vi.fn(async () => []),
    createExperiment: vi.fn(async () => ({ experimentId: "experiment-1" })),
  },
}));

vi.mock("@/hooks/useVisibleGates", () => ({
  useVisibleGates: () => [],
}));
vi.mock("@/hooks/useStrictAgentCapabilities", () => ({
  useStrictAgentCapabilities: () => false,
}));
vi.mock("@/hooks/useAdvancedMode", () => ({
  useAdvancedMode: () => [false, vi.fn()],
}));
vi.mock("@/hooks/useCommandEnter", () => ({
  useCommandEnter: vi.fn(),
  createCommandEnterKeyDown: () => () => undefined,
  isMac: false,
}));
vi.mock("@/components/ReasoningEffortSelect", () => ({
  ModelSelectItems: () => null,
  ReasoningEffortSelect: () => null,
  useModelCapabilities: () => ({
    capabilitiesMap: new Map(),
    activeModelIds: [],
    capabilitiesLoaded: true,
  }),
  useReasoningEffort: () => ({
    supportedEfforts: [],
    workerEffortWarning: undefined,
  }),
}));
vi.mock("@/components/TaskPromptPicker", () => ({
  TaskPromptPicker: () => null,
}));
vi.mock("@/components/CriteriaPicker", () => ({
  CriteriaPicker: () => null,
}));
vi.mock("@/components/CreateCriterionDialog", () => ({
  CreateCriterionDialog: () => null,
}));
vi.mock("@/components/SkillPicker", () => ({
  SkillPicker: () => null,
}));
vi.mock("@/components/CodebasePicker", () => ({
  CodebasePicker: () => null,
}));
vi.mock("@/components/ResourcePicker", () => ({
  ResourcePicker: () => null,
}));
vi.mock("@/components/ExtensionPicker", () => ({
  ExtensionPicker: () => null,
}));
vi.mock("@/components/ProfilePicker", () => ({
  ProfilePicker: () => null,
}));
vi.mock("@/components/ProfileCreateForm", () => ({
  ProfileCreateForm: () => null,
}));
vi.mock("@/components/AgentBadge", () => ({
  AgentBadge: () => null,
}));

import { SubmitRun } from "./SubmitRun";
import { api } from "@/lib/api";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderExperimentForm() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <SubmitRun mode="experiment" />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function renderRunForm() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <SubmitRun />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("SubmitRun legacy composition guidance", () => {
  it("keeps neutral guidance beside composition controls", async () => {
    renderRunForm();

    const link = await screen.findByRole("link", { name: "New Experiment" });
    const guidance = link.parentElement;
    expect(guidance?.textContent).toBe(
      "Creating multiple runs or profile variations? Use New Experiment.",
    );
    expect(guidance?.className).toContain("bg-muted/30");
    expect(guidance?.className).not.toContain("amber");
    expect(guidance?.getAttribute("role")).toBeNull();
    expect(link.getAttribute("href")).toBe("/experiments/new");
    expect(screen.queryByText(/legacy-request-composition/)).toBeNull();
    expect(screen.queryByText(/Deprecated composition/)).toBeNull();
    expect(
      guidance?.previousElementSibling?.querySelector("#occurrences"),
    ).toBeTruthy();
  });
});

describe("SubmitRun Experiment composition", () => {
  it("infers an empty Experiment until a scenario is entered", async () => {
    renderExperimentForm();

    expect(
      await screen.findByRole("button", { name: /Create empty experiment/ }),
    ).toBeTruthy();
    expect(screen.queryByLabelText("Tags")).toBeNull();
    expect(screen.queryByText("Gate pipeline")).toBeNull();
    expect(
      screen.queryByRole("switch", { name: "Toggle advanced options" }),
    ).toBeNull();
    expect(screen.getAllByText(/No scenario selected/).length).toBeGreaterThan(0);

    fireEvent.change(screen.getByLabelText(/Task/), {
      target: { value: "Implement the benchmark task" },
    });

    expect(screen.getByText("Gate pipeline")).toBeTruthy();
    expect(
      screen.getByRole("switch", { name: "Toggle advanced options" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", {
        name: /Create experiment with 5 runs/,
      }),
    ).toBeTruthy();
  });

  it("submits an explicit empty payload when no scenario is selected", async () => {
    renderExperimentForm();

    fireEvent.change(screen.getByLabelText("Name *"), {
      target: { value: "Reserved benchmark" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: /Create empty experiment/ }),
    );

    await waitFor(() => {
      expect(api.createExperiment).toHaveBeenCalledWith({
        metadata: { name: "Reserved benchmark" },
        empty: true,
      });
    });
  });
});
