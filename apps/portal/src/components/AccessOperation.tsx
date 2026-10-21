// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useState } from "react";
import { Link } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { ProjectRole } from "shared/rbac";

interface AccessChange {
  id: string;
  path: string;
  method: "PUT" | "DELETE" | "POST";
  body: { revision: number; role?: ProjectRole };
  description: string;
}
interface OperationResult { operationId: string; state: "completed" | "pending"; revision: number }
interface InspectedOperation { state: "prepared" | "completed" | "conflict" }

export function useAccessOperation(initialOperationId: string, onExecute: () => void) {
  const queryClient = useQueryClient();
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<AccessChange>();
  const [operationId, setOperationId] = useState(initialOperationId);
  const [recoveryOpen, setRecoveryOpen] = useState(Boolean(initialOperationId));
  const refresh = () => Promise.all(
    ["access-projects", "access-members", "access-users", "access-platform-admins", "projects"]
      .map(key => queryClient.invalidateQueries({ queryKey: [key] })),
  );
  const execute = async (change: AccessChange) => {
    setBusy(true); setPending(change); onExecute(); setError(""); setMessage("");
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
  return { message, setMessage, error, setError, busy, pending, operationId, setOperationId,
    recoveryOpen, setRecoveryOpen, refresh, execute, recover };
}

type AccessOperation = ReturnType<typeof useAccessOperation>;

export function AccessOperationStatus({ operation, recoveryLink }: { operation: AccessOperation; recoveryLink?: string }) {
  const { error, message, pending, busy, execute } = operation;
  return <>
    {error && <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">{error}</p>}
    {message && <p role="status" className="rounded-md border bg-muted/30 p-3 text-sm">{message}</p>}
    {pending && <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3 text-sm">
      <p>Completion is not confirmed. Retry the same change or inspect its operation{recoveryLink && <> on <Link className="underline" to={recoveryLink}>All project access</Link></>} before making another change.</p>
      <Button size="sm" variant="outline" disabled={busy} onClick={() => void execute(pending)}>Retry change</Button>
    </div>}
  </>;
}

export function AccessOperationRecovery({ operation }: { operation: AccessOperation }) {
  const { recoveryOpen, setRecoveryOpen, operationId, setOperationId, busy, recover } = operation;
  return <details open={recoveryOpen} onToggle={event => setRecoveryOpen(event.currentTarget.open)} className="rounded-md border p-4 text-sm">
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
  </details>;
}
