// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Meta, StoryObj } from "@storybook/react-vite";
import { http, HttpResponse } from "msw";
import { expect, fn, screen, userEvent, waitFor, within } from "storybook/test";
import { Link, useLocation } from "react-router-dom";
import type { AccessUserSummary, PlatformAdminSummary, ProjectMembershipSummary, ProjectRole } from "shared/rbac";
import { AccessAdministration } from "./AccessAdministration";

const projectId = "11111111-1111-4111-8111-111111111111";
const alice: AccessUserSummary = { id: "22222222-2222-4222-8222-222222222222", displayName: "Alice Example", email: "alice@example.test", role: "admin", disabled: false, revision: 1 };
const bob: AccessUserSummary = { id: "33333333-3333-4333-8333-333333333333", displayName: "Bob Example", email: "bob@example.test", role: "user", disabled: false, revision: 1 };
const charlie: AccessUserSummary = { id: "44444444-4444-4444-8444-444444444444", displayName: "Charlie Example", email: "charlie@example.test", role: "user", disabled: false, revision: 1 };
const disabled: AccessUserSummary = { ...charlie, id: "55555555-5555-4555-8555-555555555555", displayName: "Disabled user", disabled: true };
const project = { _id: projectId, name: "Scope benchmarks", revision: 1, createdAt: "2026-01-01T00:00:00Z" };
function member(user: AccessUserSummary, role: ProjectRole, extra: Partial<ProjectMembershipSummary> = {}): ProjectMembershipSummary {
  return { _id: `${projectId}:${user.id}`, projectId, userId: user.id, role, revision: 1, pending: false, user, ...extra };
}
function handlers(initial: ProjectMembershipSummary[] = [member(alice, "admin")], options: {
  unavailable?: boolean; searchError?: boolean; pending?: boolean; pageSize?: number;
  noProjects?: boolean; adminUnavailable?: boolean; adminPending?: boolean; promotionConflict?: boolean; adminPageSize?: number;
  onAdminList?: () => void;
} = {}) {
  let members = [...initial];
  let users = [alice, bob, charlie, disabled];
  let admins: PlatformAdminSummary[] = [{ ...alice, role: "admin", pending: false },
    ...(options.adminPageSize ? [{ ...charlie, role: "admin" as const, pending: false, disabled: true }] : [])];
  users = users.map(user => admins.find(admin => admin.id === user.id) ?? user);
  let retryId: string | null = null;
  let promotionId: string | null = null;
  return [
    http.get("/api/v1/projects", () => HttpResponse.json(options.noProjects ? [] : [project])),
    http.get("/api/v1/admin/platform-admins", ({ request }) => {
      options.onAdminList?.();
      if (options.adminUnavailable) return HttpResponse.json({ error: "Authority unavailable" }, { status: 503 });
      const cursor = new URL(request.url).searchParams.get("cursor");
      const start = cursor ? admins.findIndex(user => user.id === cursor) + 1 : 0;
      const page = admins.slice(start, start + (options.adminPageSize ?? 20));
      return HttpResponse.json({ items: page, ...(start + page.length < admins.length ? { nextCursor: page[page.length - 1].id } : {}) });
    }),
    http.post<{ id: string }, { revision: number }>("/api/v1/admin/users/:id/promote", async ({ request, params }) => {
      const body: { revision: number } = await request.json();
      const id = request.headers.get("Idempotency-Key");
      const user = users.find(user => user.id === params.id);
      if (!id || (promotionId && promotionId !== id)) return HttpResponse.json({ error: "Retry changed the operation key" }, { status: 409 });
      if (!user || user.disabled || user.role !== "user" || body.revision !== user.revision || options.promotionConflict) {
        return HttpResponse.json({ error: "Target revision or preconditions changed" }, { status: 409 });
      }
      if (options.adminPending && !promotionId) {
        promotionId = id;
        return HttpResponse.json({ operationId: id, state: "pending", revision: body.revision + 1 }, { status: 202 });
      }
      const promoted = { ...user, role: "admin" as const, revision: user.revision + 1 };
      users = users.map(row => row.id === user.id ? promoted : row);
      admins = [...admins, { ...promoted, pending: false, operationId: id }];
      return HttpResponse.json({ operationId: id, state: "completed", revision: promoted.revision });
    }),
    http.get("/api/v1/projects/:id/members", () => options.unavailable
      ? HttpResponse.json({ error: "Authority unavailable" }, { status: 503 })
      : HttpResponse.json(members)),
    http.get("/api/v1/admin/users/search", ({ request }) => {
      if (options.searchError) return HttpResponse.json({ error: "Directory unavailable" }, { status: 503 });
      const url = new URL(request.url);
      const query = url.searchParams.get("q")?.toLowerCase() ?? "";
      const matches = users.filter(user =>
        `${user.displayName} ${user.email} ${user.id}`.toLowerCase().includes(query),
      );
      const cursor = url.searchParams.get("cursor");
      const start = cursor ? matches.findIndex(user => user.id === cursor) + 1 : 0;
      const page = matches.slice(start, start + (options.pageSize ?? matches.length));
      return HttpResponse.json({ items: page, ...(start + page.length < matches.length ? { nextCursor: page[page.length - 1].id } : {}) });
    }),
    http.put<{ id: string; userId: string }, { role: ProjectRole; revision: number }>("/api/v1/projects/:id/members/:userId", async ({ request, params }) => {
      const body: { role: ProjectRole; revision: number } = await request.json();
      const current = members.find(row => row.userId === params.userId);
      if (body.revision !== (current?.revision ?? 0)) return HttpResponse.json({ error: "Revision mismatch" }, { status: 409 });
      const id = request.headers.get("Idempotency-Key");
      if (!id || (retryId && id !== retryId)) return HttpResponse.json({ error: "Retry changed the operation key" }, { status: 409 });
      if (options.pending && !retryId) { retryId = id; return HttpResponse.json({ operationId: id, state: "pending" }, { status: 202 }); }
      const user = [alice, bob, charlie].find(user => user.id === params.userId);
      if (!user) return HttpResponse.json({ error: "Unknown user" }, { status: 404 });
      members = [...members.filter(row => row.userId !== user.id), member(user, body.role, { revision: body.revision + 1 })];
      return HttpResponse.json({ operationId: id, state: "completed", revision: body.revision + 1 });
    }),
    http.delete<{ id: string; userId: string }, { revision: number }>("/api/v1/projects/:id/members/:userId", async ({ request, params }) => {
      const body: { revision: number } = await request.json();
      const current = members.find(row => row.userId === params.userId);
      if (body.revision !== current?.revision) return HttpResponse.json({ error: "Revision mismatch" }, { status: 409 });
      members = members.map(row => row.userId === params.userId ? { ...row, revokedAt: "2026-01-02T00:00:00Z", revision: row.revision + 1 } : row);
      return HttpResponse.json({ operationId: "remove-member", state: "completed", revision: body.revision + 1 });
    }),
  ];
}
const meta = {
  component: AccessAdministration,
  tags: ["ai-generated", "needs-work"],
  parameters: { msw: { handlers: handlers() } },
} satisfies Meta<typeof AccessAdministration>;
export default meta;
type Story = StoryObj<typeof meta>;

async function chooseProject() {
  await userEvent.selectOptions(screen.getByLabelText("Project"), await screen.findByRole("option", { name: /Scope benchmarks/ }));
  await expect(await within(await screen.findByRole("list", { name: "Project members" })).findByText("Alice Example")).toBeVisible();
}
async function selectBob() {
  await chooseProject();
  await userEvent.click(screen.getByRole("button", { name: "Add people" }));
  const dialog = within(await screen.findByRole("dialog"));
  await userEvent.type(dialog.getByLabelText("Search users"), "bob");
  const candidate = await dialog.findByRole("button", { name: /Bob Example/ });
  await userEvent.click(candidate);
  await userEvent.selectOptions(dialog.getByLabelText("Project role"), "contributor");
  await userEvent.click(dialog.getByRole("button", { name: "Add to project" }));
}

export const CurrentMembers: Story = {
  parameters: { msw: { handlers: handlers([member(alice, "admin"), member(bob, "reader"), member(charlie, "contributor", { revokedAt: "2026-01-02T00:00:00Z" })]) } },
  play: async ({ canvas }) => {
    await chooseProject();
    await expect(canvas.getByText("Bob Example")).toBeVisible();
    await expect(canvas.getByText("Reader")).toBeVisible();
    await expect(canvas.getByText("Project admin")).toBeVisible();
    await expect(canvas.getByText("bob@example.test")).toBeVisible();
    await expect(canvas.queryByRole("textbox", { name: "Find a member" })).not.toBeInTheDocument();
    await expect(canvas.queryByText("Charlie Example")).not.toBeInTheDocument();
    await expect(canvas.queryByRole("button", { name: /Create/ })).not.toBeInTheDocument();
    await expect(canvas.getByText("Advanced: operation recovery").closest("details")).not.toHaveAttribute("open");
  },
};

export const AddPeople: Story = {
  parameters: { msw: { handlers: handlers() } },
  play: async ({ canvas }) => {
    await selectBob();
    await expect(await canvas.findByText("Bob Example")).toBeVisible();
    await expect(canvas.getByText("Contributor")).toBeVisible();
    await expect(canvas.getByRole("status")).toHaveTextContent("completed");
    await expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  },
};

export const ChangeMemberRole: Story = {
  parameters: { msw: { handlers: handlers([member(alice, "admin"), member(bob, "reader")]) } },
  play: async ({ canvas }) => {
    await chooseProject();
    await userEvent.click(canvas.getByRole("button", { name: "Change role for Bob Example" }));
    const dialog = within(await screen.findByRole("dialog"));
    await userEvent.selectOptions(dialog.getByLabelText("Project role"), "contributor");
    await userEvent.click(dialog.getByRole("button", { name: "Save role" }));
    await expect(await canvas.findByText("Contributor")).toBeVisible();
  },
};

export const RemoveMember: Story = {
  parameters: { msw: { handlers: handlers([member(alice, "admin"), member(bob, "reader")]) } },
  play: async ({ canvas }) => {
    await chooseProject();
    await userEvent.click(canvas.getByRole("button", { name: "Remove Bob Example" }));
    await userEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: /^Remove access/ }));
    await expect(await canvas.findByRole("status")).toHaveTextContent("completed");
    await waitFor(() => expect(canvas.queryByText("Bob Example")).not.toBeInTheDocument());
  },
};

export const RegrantRevokedMember: Story = {
  parameters: { msw: { handlers: handlers([member(alice, "admin"), member(bob, "reader", { revokedAt: "2026-01-02T00:00:00Z", revision: 4 })]) } },
  play: async ({ canvas }) => {
    await selectBob();
    await expect(await canvas.findByRole("status")).toHaveTextContent("completed");
    await expect(canvas.getByText("Bob Example")).toBeVisible();
  },
};

export const MembershipAuthorityUnavailable: Story = {
  parameters: { msw: { handlers: handlers([], { unavailable: true }) } },
  play: async ({ canvas }) => {
    await userEvent.selectOptions(canvas.getByLabelText("Project"), await canvas.findByRole("option", { name: /Scope benchmarks/ }));
    await expect(await canvas.findByRole("alert")).toHaveTextContent("Membership authority unavailable");
    await expect(canvas.getByRole("button", { name: "Add people" })).toBeDisabled();
  },
};

export const DirectoryUnavailable: Story = {
  parameters: { msw: { handlers: handlers(undefined, { searchError: true }) } },
  play: async () => {
    await chooseProject();
    await userEvent.click(screen.getByRole("button", { name: "Add people" }));
    const dialog = within(await screen.findByRole("dialog"));
    await expect(await dialog.findByRole("alert")).toHaveTextContent("User search unavailable");
    await expect(dialog.getByRole("button", { name: "Add to project" })).toBeDisabled();
  },
};

export const PendingChangeRetry: Story = {
  parameters: { msw: { handlers: handlers(undefined, { pending: true }) } },
  play: async ({ canvas }) => {
    await selectBob();
    await expect(await canvas.findByRole("alert")).toHaveTextContent("pending reconciliation");
    await expect(canvas.getByRole("button", { name: "Add people" })).toBeDisabled();
    await userEvent.click(canvas.getByRole("button", { name: "Retry change" }));
    await expect(await canvas.findByText("Bob Example")).toBeVisible();
    await expect(canvas.getByRole("status")).toHaveTextContent("completed");
  },
};

export const ExistingAndDisabledUsers: Story = {
  parameters: { msw: { handlers: handlers() } },
  play: async () => {
    await chooseProject();
    await userEvent.click(screen.getByRole("button", { name: "Add people" }));
    const dialog = within(await screen.findByRole("dialog"));
    await expect(await dialog.findByRole("button", { name: /Alice Example/ })).toBeDisabled();
    await expect(dialog.getByRole("button", { name: /Disabled user/ })).toBeDisabled();
  },
};

export const PaginatedUsers: Story = {
  parameters: { msw: { handlers: handlers(undefined, { pageSize: 2 }) } },
  play: async () => {
    await chooseProject();
    await userEvent.click(screen.getByRole("button", { name: "Add people" }));
    const dialog = within(await screen.findByRole("dialog"));
    await userEvent.click(await dialog.findByRole("button", { name: "More users" }));
    await userEvent.click(await dialog.findByRole("button", { name: /Charlie Example/ }));
    await expect(dialog.getByRole("button", { name: "Add to project" })).toBeEnabled();
    await userEvent.click(dialog.getByRole("button", { name: "Back to first page" }));
    await expect(await dialog.findByRole("button", { name: /Bob Example/ })).toBeEnabled();
    await expect(dialog.getByRole("button", { name: "Add to project" })).toBeDisabled();
    await userEvent.type(dialog.getByLabelText("Search users"), "nobody-matches");
    await expect(await dialog.findByText("No users found.")).toBeVisible();
  },
};

export const SignedAliasWithoutVerifiedEmail: Story = {
  parameters: { msw: { handlers: handlers([member({ ...bob, email: undefined, alias: "bob.alias@example.test" }, "reader")]) } },
  play: async ({ canvas }) => {
    await userEvent.selectOptions(canvas.getByLabelText("Project"), await canvas.findByRole("option", { name: /Scope benchmarks/ }));
    await expect(await canvas.findByText("Bob Example")).toBeVisible();
    await expect(canvas.getByText("bob.alias@example.test")).toBeVisible();
    await expect(canvas.queryByText(bob.id)).not.toBeInTheDocument();
  },
};

function AccessAtRoute() {
  const { pathname } = useLocation();
  return pathname === "/access" ? <AccessAdministration /> : null;
}

const specificProjectAdminRequests = fn();
export const SpecificProject: Story = {
  parameters: { msw: { handlers: handlers([member(alice, "admin"), member(bob, "reader")], { onAdminList: specificProjectAdminRequests }) } },
  render: () => <><Link to={`/access?projectId=${projectId}`}>Open project access</Link><AccessAtRoute /></>,
  play: async ({ canvas }) => {
    specificProjectAdminRequests.mockClear();
    await userEvent.click(canvas.getByRole("link", { name: "Open project access" }));
    await expect(await canvas.findByText(project.name)).toBeVisible();
    await expect(await within(await canvas.findByRole("list", { name: "Project members" })).findByText("Alice Example")).toBeVisible();
    await expect(canvas.queryByRole("combobox", { name: "Project" })).not.toBeInTheDocument();
    await expect(canvas.queryByRole("region", { name: "Platform administrators" })).not.toBeInTheDocument();
    await expect(canvas.queryByText("Advanced: operation recovery")).not.toBeInTheDocument();
    await expect(specificProjectAdminRequests).not.toHaveBeenCalled();
    await userEvent.click(canvas.getByRole("button", { name: "Change role for Bob Example" }));
    const dialog = within(await screen.findByRole("dialog"));
    await userEvent.selectOptions(dialog.getByLabelText("Project role"), "contributor");
    await userEvent.click(dialog.getByRole("button", { name: "Save role" }));
    await expect(await canvas.findByRole("status")).toHaveTextContent("completed");
    await expect(canvas.getByText("Contributor")).toBeVisible();
    await expect(specificProjectAdminRequests).not.toHaveBeenCalled();
    await userEvent.click(canvas.getByRole("link", { name: "All project access" }));
    await expect(await within(await canvas.findByRole("region", { name: "Platform administrators" })).findByText("Alice Example")).toBeVisible();
    await expect(canvas.getByText("Advanced: operation recovery")).toBeVisible();
    await expect(specificProjectAdminRequests).toHaveBeenCalledTimes(1);
    const selector = await canvas.findByRole("combobox", { name: "Project" });
    await userEvent.selectOptions(selector, projectId);
    await expect(await within(await canvas.findByRole("list", { name: "Project members" })).findByText("Alice Example")).toBeVisible();
    await expect(canvas.getByRole("combobox", { name: "Project" })).toBeVisible();
    await userEvent.click(canvas.getByRole("link", { name: "Open project access" }));
    await expect(await canvas.findByText(project.name)).toBeVisible();
    await expect(canvas.queryByRole("region", { name: "Platform administrators" })).not.toBeInTheDocument();
    await expect(canvas.queryByText("Advanced: operation recovery")).not.toBeInTheDocument();
    await expect(specificProjectAdminRequests).toHaveBeenCalledTimes(1);
  },
};

export const SpecificProjectPendingRecovery: Story = {
  parameters: { msw: { handlers: handlers([member(alice, "admin"), member(bob, "reader", { pending: true, operationId: "pending-member-change" })]) } },
  render: () => <><Link to={`/access?projectId=${projectId}`}>Open project access</Link><AccessAtRoute /></>,
  play: async ({ canvas }) => {
    await userEvent.click(canvas.getByRole("link", { name: "Open project access" }));
    await userEvent.click(await canvas.findByRole("link", { name: "Manage pending change in All project access" }));
    await expect(canvas.getByLabelText("Operation ID")).toHaveValue("pending-member-change");
    await expect(canvas.getByText("Advanced: operation recovery").closest("details")).toHaveAttribute("open");
    await chooseProject();
    await userEvent.click(canvas.getByRole("button", { name: "Change pending" }));
    await expect(canvas.getByLabelText("Operation ID")).toHaveValue("pending-member-change");
    await expect(canvas.getByText("Advanced: operation recovery").closest("details")).toHaveAttribute("open");
  },
};

export const SpecificProjectUnconfirmedChangeRecovery: Story = {
  parameters: { msw: { handlers: handlers([member(alice, "admin"), member(bob, "reader")], { pending: true }) } },
  render: () => <><Link to={`/access?projectId=${projectId}`}>Open project access</Link><AccessAtRoute /></>,
  play: async ({ canvas }) => {
    await userEvent.click(canvas.getByRole("link", { name: "Open project access" }));
    await userEvent.click(await canvas.findByRole("button", { name: "Change role for Bob Example" }));
    const dialog = within(await screen.findByRole("dialog"));
    await userEvent.selectOptions(dialog.getByLabelText("Project role"), "contributor");
    await userEvent.click(dialog.getByRole("button", { name: "Save role" }));
    await expect(await canvas.findByRole("alert")).toHaveTextContent("pending reconciliation");
    await expect(canvas.queryByText("Advanced: operation recovery")).not.toBeInTheDocument();
    const notice = canvas.getByText(/Completion is not confirmed/);
    const recoveryLink = within(notice).getByRole("link", { name: "All project access" });
    const href = recoveryLink.getAttribute("href");
    if (!href) throw new Error("Pending change must link to its global recovery context");
    const operationId = new URL(href, "http://localhost").searchParams.get("operationId");
    await expect(operationId).toBeTruthy();
    await userEvent.click(recoveryLink);
    await expect(canvas.getByLabelText("Operation ID")).toHaveValue(operationId);
    await expect(canvas.getByText("Advanced: operation recovery").closest("details")).toHaveAttribute("open");
    await expect(canvas.getByRole("button", { name: "Inspect operation" })).toBeEnabled();
  },
};

export const MissingSpecificProject: Story = {
  render: () => <><Link to="/access?projectId=missing">Open missing project</Link><AccessAdministration /></>,
  play: async ({ canvas }) => {
    await chooseProject();
    await userEvent.click(canvas.getByRole("link", { name: "Open missing project" }));
    await expect(await canvas.findByRole("alert")).toHaveTextContent("This project is unavailable");
    await expect(canvas.queryByRole("combobox", { name: "Project" })).not.toBeInTheDocument();
    await expect(canvas.queryByRole("list", { name: "Project members" })).not.toBeInTheDocument();
    await expect(canvas.getByRole("button", { name: "Add people" })).toBeDisabled();
    await expect(canvas.queryByRole("region", { name: "Platform administrators" })).not.toBeInTheDocument();
    await expect(canvas.queryByText("Advanced: operation recovery")).not.toBeInTheDocument();
  },
};

const otherProject = { ...project, _id: "66666666-6666-4666-8666-666666666666", name: "Other project" };
export const SpecificProjectNavigation: Story = {
  parameters: { msw: { handlers: [
    http.get("/api/v1/projects", () => HttpResponse.json([project, otherProject])),
    http.get("/api/v1/projects/:id/members", ({ params }) => HttpResponse.json(params.id === projectId
      ? [member(alice, "admin")] : [member(bob, "reader", { projectId: otherProject._id })])),
    ...handlers(),
  ] } },
  render: () => <>
    <Link to={`/access?projectId=${projectId}`}>First project</Link>
    <Link to={`/access?projectId=${otherProject._id}`}>Second project</Link>
    <AccessAdministration />
  </>,
  play: async ({ canvas }) => {
    await userEvent.click(canvas.getByRole("link", { name: "First project" }));
    await expect(await within(await canvas.findByRole("list", { name: "Project members" })).findByText("Alice Example")).toBeVisible();
    await userEvent.click(canvas.getByRole("link", { name: "Second project" }));
    await expect(await canvas.findByText("Bob Example")).toBeVisible();
    await expect(canvas.getByText(otherProject.name)).toBeVisible();
    await expect(within(canvas.getByRole("list", { name: "Project members" })).queryByText("Alice Example")).not.toBeInTheDocument();
    await expect(canvas.queryByRole("combobox", { name: "Project" })).not.toBeInTheDocument();
  },
};

export const RestoreDeletedProject: Story = {
  parameters: { msw: { handlers: (() => {
    let deletedAt: string | undefined = "2026-01-02T00:00:00Z";
    return [
      http.get("/api/v1/projects", () => HttpResponse.json([{ ...project, deletedAt }])),
      http.post("/api/v1/projects/:id/restore", () => {
        deletedAt = undefined;
        return HttpResponse.json({ ...project, revision: 2 });
      }),
      ...handlers(),
    ];
  })() } },
  play: async ({ canvas }) => {
    await chooseProject();
    await expect(canvas.getByRole("button", { name: "Add people" })).toBeDisabled();
    await userEvent.click(canvas.getByRole("button", { name: "Restore project" }));
    await waitFor(() => expect(canvas.getByRole("button", { name: "Add people" })).toBeEnabled());
    await expect(canvas.queryByRole("button", { name: "Restore project" })).not.toBeInTheDocument();
  },
};

async function reviewPromotion() {
  await userEvent.click(await screen.findByRole("button", { name: "Add platform admin" }));
  const dialog = within(await screen.findByRole("dialog"));
  await expect(await dialog.findByRole("button", { name: /Alice Example/ })).toBeDisabled();
  await expect(dialog.getByRole("button", { name: /Disabled user/ })).toBeDisabled();
  await expect(dialog.queryByLabelText("Project role")).not.toBeInTheDocument();
  await userEvent.type(dialog.getByLabelText("Search users"), "bob");
  await userEvent.click(await dialog.findByRole("button", { name: /Bob Example/ }));
  await userEvent.click(dialog.getByRole("button", { name: "Review promotion" }));
  const confirmation = within(await screen.findByRole("alertdialog"));
  await expect(confirmation.getByText(/across the entire platform/)).toBeVisible();
  return confirmation;
}

export const PlatformAdminsWithoutProjects: Story = {
  parameters: { msw: { handlers: handlers([], { noProjects: true }) } },
  play: async ({ canvas }) => {
    const section = within(canvas.getByRole("region", { name: "Platform administrators" }));
    await expect(await section.findByText("Alice Example")).toBeVisible();
    await expect(section.getByRole("button", { name: "Add platform admin" })).toBeEnabled();
    await expect(canvas.getByRole("button", { name: "Add people" })).toBeDisabled();
    const heading = canvas.getByRole("heading", { name: "Platform administrators" });
    await expect(canvas.getByRole("heading", { name: "Project members" }).compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await expect(heading.compareDocumentPosition(canvas.getByText("Advanced: operation recovery")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  },
};

export const AddPlatformAdmin: Story = {
  parameters: { msw: { handlers: handlers([], { noProjects: true }) } },
  play: async ({ canvas }) => {
    const section = within(canvas.getByRole("region", { name: "Platform administrators" }));
    const confirmation = await reviewPromotion();
    await expect(section.queryByText("Bob Example")).not.toBeInTheDocument();
    await userEvent.click(confirmation.getByRole("button", { name: "Cancel" }));
    await expect(section.queryByText("Bob Example")).not.toBeInTheDocument();
    const confirmed = await reviewPromotion();
    await userEvent.click(confirmed.getByRole("button", { name: /^Grant platform admin/ }));
    await expect(await canvas.findByRole("status")).toHaveTextContent("platform-admin promotion completed");
    await expect(await section.findByText("Bob Example")).toBeVisible();
    await expect(section.queryByRole("button", { name: /Remove|Demote/ })).not.toBeInTheDocument();
  },
};

export const PendingPlatformPromotionRetry: Story = {
  parameters: { msw: { handlers: handlers([], { adminPending: true }) } },
  play: async ({ canvas }) => {
    const confirmation = await reviewPromotion();
    await userEvent.click(confirmation.getByRole("button", { name: /^Grant platform admin/ }));
    await expect(await canvas.findByRole("alert")).toHaveTextContent("pending reconciliation");
    await expect(canvas.getByRole("button", { name: "Add platform admin" })).toBeDisabled();
    await expect(canvas.queryByText("Bob Example")).not.toBeInTheDocument();
    await userEvent.click(canvas.getByRole("button", { name: "Retry change" }));
    await expect(await canvas.findByText("Bob Example")).toBeVisible();
    await expect(canvas.getByRole("status")).toHaveTextContent("completed");
  },
};

export const PlatformPromotionConflict: Story = {
  parameters: { msw: { handlers: handlers([], { promotionConflict: true }) } },
  play: async ({ canvas }) => {
    const confirmation = await reviewPromotion();
    await userEvent.click(confirmation.getByRole("button", { name: /^Grant platform admin/ }));
    await expect(await canvas.findByRole("alert")).toHaveTextContent("Target revision or preconditions changed");
    await expect(canvas.queryByRole("button", { name: "Retry change" })).not.toBeInTheDocument();
    await expect(canvas.queryByText("Bob Example")).not.toBeInTheDocument();
    await waitFor(() => expect(canvas.getByRole("button", { name: "Add platform admin" })).toBeEnabled());
  },
};

export const PlatformAdminAuthorityUnavailable: Story = {
  parameters: { msw: { handlers: handlers([], { adminUnavailable: true }) } },
  play: async ({ canvas }) => {
    const section = within(canvas.getByRole("region", { name: "Platform administrators" }));
    await expect(await section.findByRole("alert")).toHaveTextContent("Platform administrator list unavailable");
    await expect(section.getByRole("button", { name: "Add platform admin" })).toBeDisabled();
    await expect(section.queryByText("No platform administrators on this page.")).not.toBeInTheDocument();
  },
};

export const PaginatedPlatformAdmins: Story = {
  parameters: { msw: { handlers: handlers([], { adminPageSize: 1 }) } },
  play: async ({ canvas }) => {
    const section = within(canvas.getByRole("region", { name: "Platform administrators" }));
    await expect(await section.findByText("Alice Example")).toBeVisible();
    await userEvent.click(section.getByRole("button", { name: "More administrators" }));
    await expect(await section.findByText("Charlie Example")).toBeVisible();
    await expect(section.getByText("Account disabled")).toBeVisible();
    await expect(section.getByText("Platform admin (inactive)")).toBeVisible();
    await userEvent.click(section.getByRole("button", { name: "Back to first admin page" }));
    await expect(await section.findByText("Alice Example")).toBeVisible();
  },
};

export const PendingPlatformAdminRecovery: Story = {
  parameters: { msw: { handlers: [
    http.get("/api/v1/admin/platform-admins", () => HttpResponse.json({
      items: [{ ...alice, pending: true, operationId: "pending-platform-promotion" }],
    })),
    ...handlers(),
  ] } },
  play: async ({ canvas }) => {
    const section = within(canvas.getByRole("region", { name: "Platform administrators" }));
    await userEvent.click(await section.findByRole("button", { name: "Change pending" }));
    await expect(section.getByText("Platform admin (inactive)")).toBeVisible();
    await expect(canvas.getByLabelText("Operation ID")).toHaveValue("pending-platform-promotion");
    await expect(canvas.getByText("Advanced: operation recovery").closest("details")).toHaveAttribute("open");
  },
};
