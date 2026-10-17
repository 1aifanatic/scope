// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Ellipsis, Loader2, Plus, Search, ShieldCheck, Users } from "lucide-react";
import type { AccessUserSummary, ProjectMembershipSummary, ProjectRole } from "shared/rbac";
import { ProjectRoleSchema } from "shared/rbac";
import { api, ApiError } from "@/lib/api";
import { useProjectContext } from "@/contexts/ProjectContext";
import { useDebounce } from "@/hooks/useDebounce";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const roleLabels: Record<ProjectRole, string> = { reader: "Reader", contributor: "Contributor", admin: "Project admin" };
const roleDescriptions: Record<ProjectRole, string> = {
  reader: "View project content, results and stored reports. Cannot make changes.",
  contributor: "Create, edit and delete project content, and submit runs. Cannot change project settings or members.",
  admin: "Manage project content and settings. Only platform admins can manage members or delete the project.",
};
const userName = (user: AccessUserSummary) => user.displayName || user.email || user.alias || user.id;

function Person({ user, fallback }: { user?: AccessUserSummary; fallback: string }) {
  const name = user ? userName(user) : fallback;
  const address = user?.email || user?.alias;
  return <div className="flex min-w-0 items-center gap-3" title={`Scope ID: ${fallback}`}>
    <span aria-hidden="true" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-semibold">
      {name.slice(0, 2).toUpperCase()}
    </span>
    <div className="min-w-0 text-left">
      <p className="truncate font-medium">{name}</p>
      {address && address !== name && <p className="truncate text-xs text-muted-foreground">{address}</p>}
    </div>
  </div>;
}

function MemberDialog({ members, initialUser, initialRole, onClose, onSave }: {
  members: ProjectMembershipSummary[];
  initialUser?: AccessUserSummary;
  initialRole?: ProjectRole;
  onClose: () => void;
  onSave: (user: AccessUserSummary, role: ProjectRole) => void;
}) {
  const [search, setSearch] = useState("");
  const query = useDebounce(search.trim(), 250);
  const [cursor, setCursor] = useState<string>();
  const [selected, setSelected] = useState(initialUser);
  const [role, setRole] = useState<ProjectRole>(initialRole ?? "reader");
  const [error, setError] = useState("");
  const usersQuery = useQuery({
    queryKey: ["access-users", query, cursor],
    queryFn: ({ signal }) => api.searchAccessUsers({ q: query, cursor, signal }),
    enabled: !initialUser,
    retry: false,
  });
  const searching = search.trim() !== query || usersQuery.isFetching;
  return <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
    <DialogContent className="max-h-[85vh] grid-rows-[auto_minmax(0,1fr)_auto] gap-0 p-0">
      <DialogHeader className="p-6 pb-4">
        <DialogTitle>{initialUser ? "Change role" : "Add people"}</DialogTitle>
        <DialogDescription>{initialUser
          ? `Update ${userName(initialUser)}'s access to this project.`
          : "Find an existing Scope user, then choose the access to grant. No invitation is sent."}</DialogDescription>
      </DialogHeader>
      <div className="min-h-0 space-y-4 overflow-y-auto px-6 pb-6">
        {!initialUser && <>
          <Label htmlFor="access-user-search">Search users</Label>
          <div className="relative">
            <Search aria-hidden="true" className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
            <Input id="access-user-search" className="pl-9" placeholder="Search by name, email or Scope ID"
              value={search} maxLength={100} onChange={event => {
                setSearch(event.target.value); setCursor(undefined); setSelected(undefined);
              }} />
          </div>
          {usersQuery.isError ? <div role="alert" className="text-sm text-destructive">
            User search unavailable: {usersQuery.error.message}{" "}
            <Button variant="link" onClick={() => void usersQuery.refetch()}>Try again</Button>
          </div> : searching ? <p role="status" className="text-sm text-muted-foreground">Searching users...</p> : <>
            <ul aria-label="Available users" className="max-h-60 overflow-y-auto rounded-md border">
              {usersQuery.data?.items.map(user => {
                const membership = members.find(member => member.userId === user.id);
                const existing = Boolean(membership && !membership.revokedAt);
                const unavailable = user.disabled || existing || Boolean(membership?.pending);
                return <li key={user.id} className="border-b last:border-0">
                  <button type="button" aria-pressed={selected?.id === user.id} disabled={unavailable}
                    className="flex w-full items-center justify-between gap-3 px-3 py-3 text-left hover:bg-muted/50 disabled:cursor-not-allowed disabled:opacity-50"
                    onClick={() => setSelected(user)}>
                    <div className="min-w-0">
                      <Person user={user} fallback={user.id} />
                    </div>
                    {unavailable ? <Badge variant="secondary">{user.disabled ? "Disabled" : membership?.pending ? "Change pending" : "Already a member"}</Badge>
                      : selected?.id === user.id ? <Check aria-label="Selected" className="h-4 w-4 shrink-0 text-primary" /> : null}
                  </button>
                </li>;
              })}
              {!usersQuery.data?.items.length && <li className="p-6 text-center text-sm text-muted-foreground">No users found.</li>}
            </ul>
            <div className="flex justify-between gap-2">
              {cursor && <Button size="sm" variant="outline" onClick={() => { setCursor(undefined); setSelected(undefined); }}>Back to first page</Button>}
              {usersQuery.data?.nextCursor && <Button size="sm" variant="outline" className="ml-auto"
                onClick={() => { setCursor(usersQuery.data?.nextCursor); setSelected(undefined); }}>More users</Button>}
            </div>
          </>}
        </>}
        {selected && <div className="rounded-md border bg-muted/30 p-3"><Person user={selected} fallback={selected.id} /></div>}
        <div className="space-y-2">
          <Label htmlFor="membership-role">Project role</Label>
          <select id="membership-role" className="block h-10 w-full rounded-md border bg-background px-3 text-sm" value={role} onChange={event => {
            const parsed = ProjectRoleSchema.safeParse(event.target.value);
            if (!parsed.success) { setError("Choose a valid project role."); return; }
            setRole(parsed.data); setError("");
          }}>
            <option value="reader">Reader</option><option value="contributor">Contributor</option><option value="admin">Project admin</option>
          </select>
          <p className="text-sm text-muted-foreground">{roleDescriptions[role]}</p>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        </div>
      </div>
      <DialogFooter className="border-t bg-background p-4">
        <Button variant="outline" onClick={onClose}>Cancel</Button>
        <Button disabled={!selected || Boolean(selected.disabled) || Boolean(error) || (!initialUser && (searching || usersQuery.isError)) || (Boolean(initialUser) && role === initialRole)}
          onClick={() => { if (selected) onSave(selected, role); }}>{initialUser ? "Save role" : "Add to project"}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}

interface AccessChange {
  id: string;
  path: string;
  method: "PUT" | "DELETE" | "POST";
  body: { revision: number; role?: ProjectRole };
  description: string;
}
interface OperationResult { operationId: string; state: "completed" | "pending"; revision: number }
interface InspectedOperation { state: "prepared" | "completed" | "conflict" }

export function AccessAdministration() {
  const [params] = useSearchParams();
  const fixedProjectId = params.has("projectId") ? params.get("projectId") ?? "" : undefined;
  return <AccessAdministrationView key={fixedProjectId === undefined ? "all" : `project:${fixedProjectId}`} fixedProjectId={fixedProjectId} />;
}

function AccessAdministrationView({ fixedProjectId }: { fixedProjectId?: string }) {
  const queryClient = useQueryClient();
  const { selectedProjectId } = useProjectContext();
  const [chosenProjectId, setChosenProjectId] = useState(selectedProjectId ?? "");
  const scoped = fixedProjectId !== undefined;
  const projectId = fixedProjectId ?? chosenProjectId;
  const [editor, setEditor] = useState<{ user?: AccessUserSummary; role?: ProjectRole }>();
  const [confirmation, setConfirmation] = useState<{ member: ProjectMembershipSummary; disable: boolean }>();
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<AccessChange>();
  const [operationId, setOperationId] = useState("");
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const projectsQuery = useQuery({
    queryKey: ["access-projects"],
    queryFn: () => api.listProjects({ controlPlane: true, includeDeleted: true }),
    retry: false,
  });
  const selectedProject = projectsQuery.data?.find(project => project._id === projectId);
  const membersQuery = useQuery({
    queryKey: ["access-members", projectId],
    enabled: Boolean(selectedProject),
    queryFn: ({ signal }) => api.listProjectMembers(projectId, signal),
    retry: false,
  });
  const members = membersQuery.data ?? [];
  const current = members.filter(member => !member.revokedAt);
  const ready = Boolean(selectedProject && !selectedProject.deletedAt && membersQuery.isSuccess && !membersQuery.isFetching && !projectsQuery.isFetching);
  const restoreMutation = useMutation({
    mutationFn: () => api.restoreProject(projectId),
    onSuccess: () => { setError(""); setMessage("Project restored."); void refresh(); },
    onError: cause => { setMessage(""); setError(cause.message); },
  });
  const locked = busy || Boolean(pending) || restoreMutation.isPending;
  const refresh = () => Promise.all([
    queryClient.invalidateQueries({ queryKey: ["access-projects"] }),
    queryClient.invalidateQueries({ queryKey: ["access-members"] }),
    queryClient.invalidateQueries({ queryKey: ["access-users"] }),
    queryClient.invalidateQueries({ queryKey: ["projects"] }),
  ]);
  const execute = async (change: AccessChange) => {
    setBusy(true); setPending(change); setEditor(undefined); setConfirmation(undefined); setError(""); setMessage("");
    setOperationId(change.id);
    try {
      const result = await api.accessRequest<OperationResult>(change.path, change.method, change.body, change.id);
      if (result.state !== "completed") throw new Error("Access change is pending reconciliation");
      setPending(undefined); setMessage(`${change.description} completed.`);
    } catch (cause) {
      const terminal = cause instanceof ApiError && cause.status >= 400 && cause.status < 500 && ![408, 429].includes(cause.status);
      if (terminal) setPending(undefined);
      setError(`${cause instanceof Error ? cause.message : "Access change failed"} (operation ${change.id})`);
    } finally { await refresh(); setBusy(false); }
  };
  const recover = async (reconcile: boolean) => {
    if (!operationId || busy) return;
    setBusy(true); setError(""); setMessage("");
    try {
      const result = await api.accessRequest<InspectedOperation>(
        `/admin/operations/${encodeURIComponent(operationId)}${reconcile ? "/reconcile" : ""}`, reconcile ? "POST" : "GET", reconcile ? {} : undefined,
      );
      setMessage(`Operation ${operationId}: ${result.state}.`);
      if (result.state === "completed" || result.state === "conflict") {
        if (pending?.id === operationId) setPending(undefined);
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Operation recovery failed"); }
    finally { await refresh(); setBusy(false); }
  };
  return <main className="mx-auto max-w-5xl space-y-6 p-6">
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="text-2xl font-semibold">Access administration</h1>
        <p className="mt-1 text-sm text-muted-foreground">Manage who has access to your projects and what they can do.</p>
      </div>
      <div className="flex flex-wrap gap-2">
        {scoped && <Button variant="outline" asChild><Link to="/access">All project access</Link></Button>}
        <Button variant="outline" asChild><Link to="/projects">Your projects</Link></Button>
      </div>
    </header>
    <div className="max-w-xl space-y-2">
      {scoped ? <div>
        <p className="text-sm text-muted-foreground">Project</p>
        <p className="text-lg font-semibold">{selectedProject?.name ?? (projectsQuery.isPending ? "Loading project..." : "Project unavailable")}</p>
      </div> : <>
      <Label htmlFor="access-project">Project</Label>
      <select id="access-project" className="block h-10 w-full rounded-md border bg-background px-3 text-sm"
        disabled={locked || projectsQuery.isPending || projectsQuery.isError} value={projectId} onChange={event => {
          setChosenProjectId(event.target.value);
          setMessage(""); setError("");
        }}>
        <option value="">Select a project</option>
        {projectsQuery.data?.map(project => <option key={project._id} value={project._id}>
          {project.name} ({project._id.slice(0, 8)}){project.deletedAt ? " — deleted" : ""}
        </option>)}
      </select>
      </>}
      {projectsQuery.isError && <p role="alert" className="text-sm text-destructive">Project inventory unavailable: {projectsQuery.error.message}</p>}
      {projectsQuery.isSuccess && (scoped || projectId) && !selectedProject && <p role="alert">
        This project is unavailable.{scoped ? " Open All project access to choose another project." : " Choose another project."}
      </p>}
    </div>
    {error && <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">{error}</p>}
    {message && <p role="status" className="rounded-md border bg-muted/30 p-3 text-sm">{message}</p>}
    {pending && <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3 text-sm">
      <p>Completion is not confirmed. Retry the same change or inspect its operation before making another change.</p>
      <Button size="sm" variant="outline" disabled={busy} onClick={() => void execute(pending)}>Retry change</Button>
    </div>}
    <section className="overflow-hidden rounded-lg border">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b bg-muted/30 p-4">
        <h2 className="flex items-center gap-2 font-semibold"><Users aria-hidden="true" className="h-4 w-4" />Project members
          {membersQuery.isSuccess && <Badge variant="secondary">{current.length}</Badge>}
        </h2>
        <Button size="sm" disabled={!ready || locked} onClick={() => setEditor({})}><Plus aria-hidden="true" className="mr-2 h-4 w-4" />Add people</Button>
      </div>
      {!selectedProject ? <div className="p-10 text-center text-sm text-muted-foreground">{scoped ? "Project membership is unavailable." : "Select a project to view its members."}</div>
        : membersQuery.isError ? <div role="alert" className="p-4 text-sm text-destructive">
          Membership authority unavailable: {membersQuery.error.message}{" "}
          <Button variant="link" onClick={() => void membersQuery.refetch()}>Try again</Button>
        </div> : membersQuery.isPending ? <p role="status" className="flex items-center gap-2 p-6 text-sm"><Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />Loading members...</p>
          : <>
            {selectedProject.deletedAt && <div className="flex items-center justify-between gap-3 border-b p-4 text-sm">
              <p className="text-muted-foreground">This project is deleted. Restore it before changing access.</p>
              <Button size="sm" variant="outline" disabled={locked} onClick={() => restoreMutation.mutate()}>Restore project</Button>
            </div>}
            <ul aria-label="Project members" className="divide-y">
              {current.map(member => <li key={member._id} className="flex flex-wrap items-center justify-between gap-4 p-4">
                <Person user={member.user} fallback={member.userId} />
                <div className="flex flex-wrap items-center gap-2">
                  {member.user?.disabled && <Badge variant="secondary">Account disabled</Badge>}
                  {member.pending && <Button variant="link" size="sm" onClick={() => { setOperationId(member.operationId ?? ""); setRecoveryOpen(true); }}>Change pending</Button>}
                  <Badge variant="outline">{roleLabels[member.role]}</Badge>
                  <Button size="sm" variant="outline" aria-label={`Change role for ${member.user ? userName(member.user) : member.userId}`}
                    disabled={!ready || locked || member.pending || !member.user || member.user.disabled} onClick={() => setEditor({ user: member.user, role: member.role })}>Change role</Button>
                  <Button size="sm" variant="ghost" aria-label={`Remove ${member.user ? userName(member.user) : member.userId}`}
                    disabled={!ready || locked || member.pending} onClick={() => setConfirmation({ member, disable: false })}>Remove</Button>
                  {member.user?.role === "user" && !member.user.disabled && <DropdownMenu>
                    <DropdownMenuTrigger asChild><Button variant="ghost" size="icon" aria-label={`More actions for ${userName(member.user)}`} disabled={!ready || locked}>
                      <Ellipsis aria-hidden="true" className="h-4 w-4" /></Button></DropdownMenuTrigger>
                    <DropdownMenuContent align="end"><DropdownMenuItem className="text-destructive" onClick={() => setConfirmation({ member, disable: true })}>Disable account</DropdownMenuItem></DropdownMenuContent>
                  </DropdownMenu>}
                </div>
              </li>)}
              {!current.length && <li className="space-y-2 p-10 text-center text-sm text-muted-foreground">
                <Users aria-hidden="true" className="mx-auto h-8 w-8" />
                <p>No members yet. Add people to give them access to this project.</p>
              </li>}
            </ul>
          </>}
    </section>
    <p className="flex items-start gap-2 text-sm text-muted-foreground"><ShieldCheck aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
      Only platform admins can manage membership. Platform administration alone does not grant project content access.</p>
    <details open={recoveryOpen} onToggle={event => setRecoveryOpen(event.currentTarget.open)} className="rounded-md border p-4 text-sm">
      <summary className="cursor-pointer font-medium">Advanced: operation recovery</summary>
      <div className="mt-4 space-y-3">
        <p className="text-muted-foreground">Access changes are audited. Inspect or reconcile an uncertain operation without repeating a different change.</p>
        <Label htmlFor="operation-id">Operation ID</Label>
        <Input id="operation-id" value={operationId} disabled={busy} onChange={event => setOperationId(event.target.value)} />
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" disabled={busy || !operationId} onClick={() => void recover(false)}>Inspect operation</Button>
          <Button variant="outline" disabled={busy || !operationId} onClick={() => void recover(true)}>Reconcile operation</Button>
        </div>
      </div>
    </details>
    {editor && <MemberDialog members={members} initialUser={editor.user} initialRole={editor.role} onClose={() => setEditor(undefined)}
      onSave={(user, role) => {
        const membership = members.find(member => member.userId === user.id);
        void execute({
          id: crypto.randomUUID(), path: `/projects/${encodeURIComponent(projectId)}/members/${encodeURIComponent(user.id)}`, method: "PUT",
          body: { role, revision: membership?.revision ?? 0 }, description: `${userName(user)}'s ${roleLabels[role]} access`,
        });
      }} />}
    <AlertDialog open={Boolean(confirmation)} onOpenChange={open => { if (!open) setConfirmation(undefined); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{confirmation?.disable ? "Disable this account?" : "Remove project access?"}</AlertDialogTitle>
          <AlertDialogDescription>{confirmation?.disable
            ? "This disables the ordinary user's access across the entire platform. Operator recovery is required to re-enable the account."
            : "This person will lose access to this project. Their content and accepted runs stay with the project."}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" onClick={() => {
            if (!confirmation) return;
            const { member, disable } = confirmation;
            const revision = disable ? member.user?.revision : member.revision;
            if (revision === undefined) { setError("User details are unavailable. Refresh the member list before disabling this account."); return; }
            void execute({
              id: crypto.randomUUID(),
              path: disable ? `/admin/users/${encodeURIComponent(member.userId)}/disable` : `/projects/${encodeURIComponent(projectId)}/members/${encodeURIComponent(member.userId)}`,
              method: disable ? "POST" : "DELETE", body: { revision },
              description: disable ? "Account disable" : "Project membership removal",
            });
          }}>{confirmation?.disable ? "Disable account" : "Remove access"}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </main>;
}
