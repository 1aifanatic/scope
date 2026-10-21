// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// @vitest-environment happy-dom
import { afterAll, afterEach, beforeAll, describe, it } from "vitest";
import { cleanup, render, within } from "@testing-library/react";
import { composeStories } from "@storybook/react-vite";
import { setupServer } from "msw/node";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { toast } from "sonner";
import { AuthContext } from "@/contexts/AuthContext";
import { signedInAuth } from "@/contexts/authFixtures";
import { ProjectProvider } from "@/contexts/ProjectContext";
import * as downloads from "./ArtifactDownloadButton.stories";
import * as network from "./HarNetworkViewer.stories";
import * as conversation from "./ConversationView.stories";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterAll(() => server.close());
afterEach(() => { cleanup(); toast.dismiss(); server.resetHandlers(); });

describe("artifact interaction stories", () => {
  const downloadStories = composeStories(downloads);
  it("shows pending state and permits cancellation", async () => {
    server.use(...downloads.PendingAndCancel.parameters.msw.handlers);
    const client = new QueryClient();
    const { container } = render(<QueryClientProvider client={client}>
      <AuthContext.Provider value={signedInAuth}><ProjectProvider>
        <downloadStories.PendingAndCancel />
      </ProjectProvider></AuthContext.Provider>
    </QueryClientProvider>);
    await downloads.PendingAndCancel.play({ canvas: within(container) });
    client.clear();
  });

  it("shows a download authorization failure", async () => {
    server.use(...downloads.AccessDenied.parameters.msw.handlers);
    const { container } = render(<AuthContext.Provider value={signedInAuth}><ProjectProvider>
      <downloadStories.AccessDenied />
    </ProjectProvider></AuthContext.Provider>);
    await downloads.AccessDenied.play({ canvas: within(container) });
  });

  it("shows a HAR authorization failure", async () => {
    server.use(...network.AccessDenied.parameters.msw.handlers);
    const stories = composeStories(network);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { container } = render(<QueryClientProvider client={client}>
      <AuthContext.Provider value={signedInAuth}><ProjectProvider>
        <stories.AccessDenied />
      </ProjectProvider></AuthContext.Provider>
    </QueryClientProvider>);
    await network.AccessDenied.play({ canvas: within(container) });
    client.clear();
  });

  it("shows a conversation HAR failure without hiding the stored response", async () => {
    server.use(...conversation.HarAccessDenied.parameters.msw.handlers);
    const stories = composeStories(conversation);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { container } = render(<QueryClientProvider client={client}>
      <AuthContext.Provider value={signedInAuth}><ProjectProvider>
        <stories.HarAccessDenied />
      </ProjectProvider></AuthContext.Provider>
    </QueryClientProvider>);
    await conversation.HarAccessDenied.play({ canvas: within(container) });
    client.clear();
  });
});
