// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// @vitest-environment happy-dom
import { afterAll, afterEach, beforeAll, describe, it } from "vitest";
import { cleanup, render, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { composeStories } from "@storybook/react-vite";
import { setupServer } from "msw/node";
import type { RequestHandler } from "msw";
import { MemoryRouter } from "react-router-dom";
import { ProjectProvider } from "@/contexts/ProjectContext";
import * as administration from "./AccessAdministration.stories";
import * as accessShell from "../components/AccessShell.stories";

const server = setupServer();
const clients: QueryClient[] = [];
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterAll(() => server.close());
afterEach(() => {
  cleanup();
  clients.splice(0).forEach(client => client.clear());
  server.resetHandlers();
  localStorage.clear();
});

const stories = { ...composeStories(administration), ...composeStories(accessShell) };
describe("Access story interactions", () => {
  for (const [name, Story] of Object.entries(stories)) {
    it(`${name} renders and play passes`, async () => {
      const parameters: { msw?: { handlers?: RequestHandler[] } } = Story.parameters;
      server.use(...(parameters.msw?.handlers ?? []));
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      clients.push(client);
      const { container } = render(<QueryClientProvider client={client}><ProjectProvider><MemoryRouter><Story /></MemoryRouter></ProjectProvider></QueryClientProvider>);
      if (!Story.play) throw new Error(`${name} is missing its required interaction test`);
      await Story.play({ canvas: within(container), canvasElement: container });
    });
  }
});
