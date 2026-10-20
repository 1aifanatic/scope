// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useLayoutEffect, useMemo } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { useSelectedProjectId } from "@/contexts/ProjectContext";
import { getApiSessionSignal } from "@/lib/api-client";

export function useArtifactSession(resource: string) {
  const { account, user, isReady } = useAuth();
  const projectId = useSelectedProjectId();
  const session = useMemo(() => ({
    resource, projectId, ready: isReady && !!projectId, controller: new AbortController(),
    accountSignal: getApiSessionSignal(),
    key: [resource, projectId, user?.id, account?.homeAccountId, account?.localAccountId, account?.tenantId, account?.environment],
  }), [
    resource, projectId, isReady, user?.id, account?.homeAccountId,
    account?.localAccountId, account?.tenantId, account?.environment,
  ]);
  useLayoutEffect(() => {
    const controller = new AbortController();
    session.controller = controller;
    const cancel = () => controller.abort();
    if (session.accountSignal?.aborted) cancel();
    session.accountSignal?.addEventListener("abort", cancel, { once: true });
    return () => {
      session.accountSignal?.removeEventListener("abort", cancel);
      controller.abort();
    };
  }, [session]);
  return session;
}
