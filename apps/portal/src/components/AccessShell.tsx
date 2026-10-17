// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useEffect, type ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import { useProjectContext } from "@/contexts/ProjectContext";
import { Button } from "@/components/ui/button";

export function NoAccessView({ userId, onLogout }: { userId: string; onLogout: () => void }) {
  return <main className="mx-auto max-w-xl space-y-4 p-10">
    <h1 className="text-xl font-semibold">No project access</h1>
    <p>Your account is enrolled. Ask a platform administrator to assign a project membership.</p>
    <p>Your Scope user ID: <code>{userId}</code></p>
    <Button onClick={onLogout}>Sign out</Button>
  </main>;
}

export function AccessShell({ children }: { children: ReactNode }) {
  const { user, logout, authEnabled } = useAuth();
  const { selectedProjectId, setSelectedProjectId } = useProjectContext();
  const location = useLocation();
  const capabilities = user?.capabilities;
  const member = capabilities?.memberships.some(m => m.projectId === selectedProjectId);
  useEffect(() => {
    if (authEnabled && selectedProjectId && !member) setSelectedProjectId(undefined);
  }, [authEnabled, selectedProjectId, member, setSelectedProjectId]);
  if (!authEnabled) {
    return location.pathname === "/access"
      ? <main className="p-10">Access administration requires authentication to be enabled.</main>
      : <>{children}</>;
  }
  if (!capabilities) return <main className="p-10">Access capabilities are unavailable.</main>;
  if (!capabilities.platformAdmin && !capabilities.memberships.length) {
    return <NoAccessView userId={user!.id} onLogout={() => { void logout(); }} />;
  }
  if ((location.pathname.startsWith("/admin") || location.pathname.startsWith("/secrets") || location.pathname === "/access") &&
    !capabilities.platformAdmin) return <main className="p-10">Platform administration is not permitted.</main>;
  if (["/agents", "/models"].some(path => location.pathname.startsWith(path)) && !capabilities.memberships.length) {
    return <main className="p-10">Catalog access requires an active project membership.</main>;
  }
  if (location.pathname.endsWith("/new") && !capabilities.memberships.some(m => m.projectId === selectedProjectId && m.permissions.includes("content:write"))) {
    return <main className="p-10">Your project role permits reading only.</main>;
  }
  return <>
    {capabilities.platformAdmin && <div className="border-b px-4 py-2 text-sm"><Link to="/access">Access administration</Link></div>}
    {selectedProjectId && !member ? <main className="p-10">Project access has changed. Select an accessible project.</main> : children}
  </>;
}
