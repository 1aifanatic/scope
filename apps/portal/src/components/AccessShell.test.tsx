// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it } from "vitest";
import { AuthContext, type AuthContextValue } from "@/contexts/AuthContext";
import { anonymousAuth, signedInAuth } from "@/contexts/authFixtures";
import { ProjectProvider } from "@/contexts/ProjectContext";
import { PROJECT_STORAGE_KEY } from "@/lib/project-scope";
import { AccessShell } from "./AccessShell";

afterEach(() => { cleanup(); localStorage.removeItem(PROJECT_STORAGE_KEY); });

function tree(auth: AuthContextValue, path = "/runs") {
  return <AuthContext.Provider value={auth}><ProjectProvider>
    <MemoryRouter initialEntries={[path]}><AccessShell><p>Project content</p></AccessShell></MemoryRouter>
  </ProjectProvider></AuthContext.Provider>;
}
const noMembership: AuthContextValue = {
  ...signedInAuth, user: signedInAuth.user && { ...signedInAuth.user,
    capabilities: { platformAdmin: false, reportsEnabled: false, memberships: [] } },
};

it("renders anonymous content without manufacturing capabilities or clearing a selected project", () => {
  localStorage.setItem(PROJECT_STORAGE_KEY, "anonymous-project");
  render(tree(anonymousAuth));
  expect(screen.getByText("Project content")).toBeTruthy();
  expect(localStorage.getItem(PROJECT_STORAGE_KEY)).toBe("anonymous-project");
  expect(screen.queryByText("Access capabilities are unavailable.")).toBeNull();
  expect(screen.queryByRole("link", { name: "Access administration" })).toBeNull();
});
it("does not expose access administration when auth is disabled", () => {
  render(tree(anonymousAuth, "/access"));
  expect(screen.getByText("Access administration requires authentication to be enabled.")).toBeTruthy();
  expect(screen.queryByText("Project content")).toBeNull();
});

it("shows only the enrolled account when no memberships exist", () => {
  render(tree(noMembership));
  expect(screen.getByRole("heading", { name: "No project access" })).toBeTruthy();
  expect(screen.queryByText("Project content")).toBeNull();
  expect(screen.queryByRole("link")).toBeNull();
});
it("clears a selected project after membership removal", async () => {
  localStorage.setItem(PROJECT_STORAGE_KEY, "demo-project");
  const view = render(tree(signedInAuth));
  expect(screen.getByText("Project content")).toBeTruthy();
  view.rerender(tree(noMembership));
  await waitFor(() => expect(localStorage.getItem(PROJECT_STORAGE_KEY)).toBeNull());
  expect(screen.queryByText("Project content")).toBeNull();
});
it("does not allow an ordinary member to open platform administration", () => {
  render(tree(signedInAuth, "/access"));
  expect(screen.getByText("Platform administration is not permitted.")).toBeTruthy();
  expect(screen.queryByText("Project content")).toBeNull();
});
it("allows platform control-plane onboarding without implicit membership", () => {
  const admin = { ...noMembership, user: noMembership.user && { ...noMembership.user,
    capabilities: { platformAdmin: true, reportsEnabled: false as const, memberships: [] } } };
  render(tree(admin, "/access"));
  expect(screen.getByRole("link", { name: "Access administration" })).toBeTruthy();
  expect(screen.getByText("Project content")).toBeTruthy();
});
