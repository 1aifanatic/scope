// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, FileText, RotateCcw } from "lucide-react";
import { Link, useParams } from "react-router-dom";
import { toast } from "sonner";
import { ExperimentStatusCard } from "@/components/ExperimentStatusCard";
import { ShortId } from "@/components/ShortId";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ApiError, api } from "@/lib/api";
import type { ExperimentExecutionView } from "@/lib/experiments";
import { formatDate } from "@/lib/utils";

function ExecutionSummary({
  execution,
}: {
  execution: ExperimentExecutionView;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">
          Execution attempt {execution.attemptNumber}
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3 text-sm sm:grid-cols-3">
        <div>
          <div className="text-muted-foreground">Execution ID</div>
          <ShortId
            id={execution.experimentExecutionId}
            label="experiment execution ID"
          />
        </div>
        <div>
          <div className="text-muted-foreground">Runs</div>
          <div className="font-medium">{execution.requestCount}</div>
        </div>
        <div>
          <div className="text-muted-foreground">Created</div>
          <div className="font-medium">{formatDate(execution.createdAt)}</div>
        </div>
      </CardContent>
    </Card>
  );
}

export function ExperimentDetail() {
  const { id } = useParams<{ id: string }>();
  const queryClient = useQueryClient();
  const [selectedExecutionId, setSelectedExecutionId] = useState<string>();
  const experimentQuery = useQuery({
    queryKey: ["experiment", id],
    queryFn: () => api.getExperiment(id!),
    enabled: Boolean(id),
    refetchInterval: (query) => {
      const readiness = query.state.data?.readiness;
      return readiness === "done" ||
        readiness === "failed" ||
        readiness === "blocked"
        ? false
        : 5_000;
    },
  });
  const executionsQuery = useQuery({
    queryKey: ["experiment-executions", id],
    queryFn: () => api.listExperimentExecutions(id!, { limit: 50 }),
    enabled: Boolean(id) && experimentQuery.isSuccess,
  });
  const selectedExecutionQuery = useQuery({
    queryKey: ["experiment-execution", id, selectedExecutionId],
    queryFn: () => api.getExperimentExecution(id!, selectedExecutionId!),
    enabled: Boolean(id && selectedExecutionId),
  });
  const retry = useMutation({
    mutationFn: () =>
      api.retryExperiment(
        experimentQuery.data!.experimentId,
        experimentQuery.data!.execution.experimentExecutionId,
      ),
    onSuccess: () => {
      toast.success("Experiment processing restarted");
      void queryClient.invalidateQueries({ queryKey: ["experiment", id] });
      void queryClient.invalidateQueries({
        queryKey: ["experiment-executions", id],
      });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Retry failed");
    },
  });

  if (experimentQuery.isLoading) {
    return (
      <div className="p-6 text-sm text-muted-foreground">
        Loading experiment…
      </div>
    );
  }
  if (experimentQuery.isError || !experimentQuery.data) {
    const correlationOnly =
      experimentQuery.error instanceof ApiError &&
      experimentQuery.error.status === 404;
    return (
      <div className="mx-auto w-full max-w-4xl space-y-4 p-6">
        <Button variant="ghost" size="sm" asChild className="-ml-3">
          <Link to="/experiments">
            <ArrowLeft className="mr-2 h-4 w-4" />
            Experiments
          </Link>
        </Button>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {correlationOnly
                ? "Historical experiment correlation"
                : "Experiment could not be loaded"}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm text-muted-foreground">
            {correlationOnly ? (
              <>
                <p>
                  <span className="font-mono text-foreground">{id}</span> is
                  attached to historical runs but has no canonical Experiment
                  document.
                </p>
                <p>
                  This correlation is view-only. It cannot be retried or used to
                  trigger processing.
                </p>
              </>
            ) : (
              <p className="text-destructive">
                {experimentQuery.error instanceof Error
                  ? experimentQuery.error.message
                  : "The experiment request failed."}
              </p>
            )}
          </CardContent>
        </Card>
      </div>
    );
  }

  const experiment = experimentQuery.data;
  const canRetry = !["waiting", "processing"].includes(
    experiment.readiness ?? "",
  );

  return (
    <div className="mx-auto w-full max-w-6xl space-y-6 p-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <Button variant="ghost" size="sm" asChild className="-ml-3 mb-2">
            <Link to="/experiments">
              <ArrowLeft className="mr-2 h-4 w-4" />
              Experiments
            </Link>
          </Button>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-semibold">
              {experiment.metadata.name}
            </h1>
            <ShortId id={experiment.experimentId} label="experiment ID" />
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            Created {formatDate(experiment.createdAt)}
          </p>
        </div>
        <Button
          variant="outline"
          onClick={() => retry.mutate()}
          disabled={retry.isPending || !canRetry}
        >
          <RotateCcw className="mr-2 h-4 w-4" />
          Retry processing
        </Button>
      </div>

      {experiment.metadata.description && (
        <p className="text-sm text-muted-foreground">
          {experiment.metadata.description}
        </p>
      )}

      <ExperimentStatusCard experiment={experiment} />

      {experiment.blocking.length > 0 && (
        <Card className="border-destructive/40">
          <CardHeader>
            <CardTitle className="text-base">Blocking dependencies</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {experiment.blocking.map((blocking, index) => (
              <div
                key={`${blocking.handlerId}:${blocking.requestId ?? index}`}
                className="flex flex-wrap items-center gap-2 text-sm"
              >
                {blocking.requestId && (
                  <Link
                    to={`/runs/${blocking.requestId}`}
                    className="font-mono text-primary hover:underline"
                  >
                    {blocking.requestId.slice(0, 8)}
                  </Link>
                )}
                <Badge variant="destructive">{blocking.reason}</Badge>
                <span className="font-mono text-xs text-muted-foreground">
                  {blocking.handlerId}
                </span>
                {blocking.error && <span>{blocking.error}</span>}
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Current runs</CardTitle>
        </CardHeader>
        <CardContent className="divide-y">
          {experiment.execution.requests.length === 0 ? (
            <p className="py-4 text-sm text-muted-foreground">
              {experiment.execution.requestCount === 0
                ? "This experiment is empty."
                : `${experiment.execution.requestCount} linked runs are stored outside the inline response.`}
            </p>
          ) : (
            experiment.execution.requests.map((request) => (
              <Link
                key={request.requestId}
                to={`/runs/${request.requestId}`}
                className="flex items-center justify-between gap-4 py-4 hover:bg-muted/40"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <span className="truncate font-medium">
                      {request.task ?? request.requestId}
                    </span>
                  </div>
                  <div className="mt-1 font-mono text-xs text-muted-foreground">
                    {request.requestId} · {request.runId}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {request.status && (
                    <Badge variant="outline">{request.status}</Badge>
                  )}
                  {request.outcome && (
                    <Badge variant="secondary">{request.outcome}</Badge>
                  )}
                </div>
              </Link>
            ))
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Execution history</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {executionsQuery.isLoading && (
            <p className="text-sm text-muted-foreground">
              Loading execution history…
            </p>
          )}
          {executionsQuery.data?.items.map((execution) => (
            <button
              key={execution.experimentExecutionId}
              type="button"
              onClick={() =>
                setSelectedExecutionId(execution.experimentExecutionId)
              }
              className="flex w-full items-center justify-between rounded-md border p-3 text-left hover:bg-muted/40"
            >
              <span>
                Attempt {execution.attemptNumber}
                {execution.supersededReason
                  ? ` · ${execution.supersededReason}`
                  : ""}
              </span>
              <ShortId
                id={execution.experimentExecutionId}
                label="experiment execution ID"
              />
            </button>
          ))}
        </CardContent>
      </Card>

      {selectedExecutionQuery.isLoading && (
        <p className="text-sm text-muted-foreground">Loading execution…</p>
      )}
      {selectedExecutionQuery.data && (
        <ExecutionSummary execution={selectedExecutionQuery.data} />
      )}
    </div>
  );
}
