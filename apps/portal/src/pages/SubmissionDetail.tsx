// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import {
  useCallback,
  useMemo,
} from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  ArrowRight,
  Clock,
  Download,
  FileText,
  ListChecks,
  RotateCcw,
  ScrollText,
} from "lucide-react";
import {
  Link,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import { toast } from "sonner";
import { LogViewer } from "@/components/LogViewer";
import { MarkdownRenderer } from "@/components/MarkdownRenderer";
import { ShortId } from "@/components/ShortId";
import {
  SubmissionStatusCard,
  submissionHandlerLabel,
} from "@/components/SubmissionStatusCard";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import {
  DataTable,
  type DataTableColumn,
} from "@/components/list-layout";
import { useLogStream } from "@/hooks/use-log-stream";
import { api } from "@/lib/api";
import { cn, formatDate } from "@/lib/utils";
import type {
  Report,
  Submission,
  SubmissionReadiness,
  SubmissionRequestSummary,
  SubmissionRunAttempt,
} from "@/types";

type SubmissionTab = "reports" | "runs" | "processing";

interface SubmissionMemberRow extends SubmissionRequestSummary {
  dependencyStates: Array<{
    handlerId: string;
    state: string;
  }>;
  historical: boolean;
}

function deriveAttemptReadiness(
  attempt: SubmissionRunAttempt,
): SubmissionReadiness {
  if (attempt.blocking.length > 0) return "blocked";
  const handlers = Object.values(attempt.handlerStatus ?? {});
  if (handlers.some((handler) => handler.status === "failed")) return "failed";
  if (handlers.some((handler) => handler.status === "processing")) {
    return "processing";
  }
  if (handlers.length > 0 && handlers.every((handler) => handler.status === "done")) {
    return "done";
  }
  if (
    attempt.dependencyProjection.length > 0 &&
    attempt.dependencyProjection.every((dependency) => dependency.state === "ready")
  ) {
    return "ready";
  }
  return "waiting";
}

function reportId(report: Report): string {
  return report.id || report._id;
}

function attemptLabel(
  attempt: SubmissionRunAttempt,
  currentAttemptId: string,
): string {
  const state =
    attempt._id === currentAttemptId
      ? "Current"
      : attempt.supersededAt
        ? "Superseded"
        : "Historical";
  return `Attempt ${attempt.attemptNumber} · ${state} · ${formatDate(attempt.createdAt)}`;
}

function SubmissionAttemptPicker({
  attempts,
  currentAttemptId,
  selectedAttemptId,
  onSelect,
}: {
  attempts: SubmissionRunAttempt[];
  currentAttemptId: string;
  selectedAttemptId: string;
  onSelect: (attemptId: string) => void;
}) {
  return (
    <div className="min-w-72">
      <label
        htmlFor="submission-attempt"
        className="mb-1 block text-[10px] font-medium uppercase tracking-wider text-muted-foreground"
      >
        Submission attempt
      </label>
      <Select value={selectedAttemptId} onValueChange={onSelect}>
        <SelectTrigger id="submission-attempt" aria-label="Submission attempt">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {attempts.map((attempt) => (
            <SelectItem key={attempt._id} value={attempt._id}>
              {attemptLabel(attempt, currentAttemptId)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function SubmissionReports({
  reports,
  selectedReport,
  currentReportId,
  selectedAttempt,
  readiness,
  onSelect,
  onShowProcessing,
}: {
  reports: Report[];
  selectedReport?: Report;
  currentReportId?: string;
  selectedAttempt: SubmissionRunAttempt;
  readiness: SubmissionReadiness;
  onSelect: (report: Report) => void;
  onShowProcessing: () => void;
}) {
  const unavailableMessage =
    readiness === "blocked"
      ? "Report generation is blocked by one or more dependencies."
      : readiness === "failed"
        ? "Report generation failed and can be retried from the current attempt."
        : readiness === "processing"
          ? "A report is being generated for this attempt."
          : "No report has been generated for this attempt yet.";
  const unavailable = (
    <Card>
      <CardContent className="flex flex-col items-start gap-3 py-8">
        <div>
          <h2 className="font-medium">Report not available</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {unavailableMessage}
          </p>
        </div>
        <Button variant="outline" onClick={onShowProcessing}>
          <ScrollText className="mr-2 h-4 w-4" />
          View processing
        </Button>
      </CardContent>
    </Card>
  );
  if (reports.length === 0) return unavailable;

  return (
    <div className="grid gap-4 lg:grid-cols-[17rem_minmax(0,1fr)]">
      <Card className="h-fit">
        <CardHeader>
          <CardTitle className="text-base">Reports</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {reports.map((report) => {
            const id = reportId(report);
            const isCurrent = id === currentReportId;
            const isSelected = id === (selectedReport && reportId(selectedReport));
            const isSelectedAttempt =
              report.submissionRunId === selectedAttempt._id;
            return (
              <button
                key={id}
                type="button"
                onClick={() => onSelect(report)}
                className={cn(
                  "w-full rounded-md border p-3 text-left transition-colors hover:bg-muted/50",
                  isSelected && "border-primary bg-primary/5",
                )}
                aria-pressed={isSelected}
              >
                <div className="flex items-center justify-between gap-2">
                  <ShortId id={id} label="report ID" />
                  {isCurrent ? (
                    <Badge>Current</Badge>
                  ) : isSelectedAttempt ? (
                    <Badge variant="outline">This attempt</Badge>
                  ) : (
                    <Badge variant="secondary">Historical</Badge>
                  )}
                </div>
                <div className="mt-2 flex items-center justify-between gap-2 text-xs text-muted-foreground">
                  <span>{report.status}</span>
                  <span>{formatDate(report.createdAt)}</span>
                </div>
              </button>
            );
          })}
        </CardContent>
      </Card>

      {selectedReport ? (
        <Card>
          <>
            <CardHeader className="gap-4 border-b">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <CardTitle className="text-base">Generated report</CardTitle>
                    <Badge
                      variant={
                        reportId(selectedReport) === currentReportId
                          ? "default"
                          : "secondary"
                      }
                    >
                      {reportId(selectedReport) === currentReportId
                        ? "Current"
                        : "Historical"}
                    </Badge>
                    <Badge variant="outline">{selectedReport.status}</Badge>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                    <span>
                      Report <ShortId id={reportId(selectedReport)} label="report ID" />
                    </span>
                    {selectedReport.submissionRunId && (
                      <span>
                        Attempt{" "}
                        <ShortId
                          id={selectedReport.submissionRunId}
                          label="submission run ID"
                        />
                      </span>
                    )}
                    <span>Created {formatDate(selectedReport.createdAt)}</span>
                    {selectedReport.updatedAt && (
                      <span>Updated {formatDate(selectedReport.updatedAt)}</span>
                    )}
                  </div>
                  {selectedReport.reporter && (
                    <p className="mt-2 text-xs text-muted-foreground">
                      {selectedReport.reporter.name} · {selectedReport.reporter.model} ·{" "}
                      {selectedReport.reporter.agentId}@
                      {selectedReport.reporter.agentVersion}
                    </p>
                  )}
                </div>
                {selectedReport.structuredArtifact && (
                  <Button variant="outline" size="sm" asChild>
                    <a
                      href={api.reportStructuredUrl(reportId(selectedReport))}
                      download
                    >
                      <Download className="mr-2 h-4 w-4" />
                      Structured JSON
                    </a>
                  </Button>
                )}
              </div>
            </CardHeader>
            <CardContent className="py-6">
              {selectedReport.content ? (
                <div className="prose max-w-none dark:prose-invert">
                  <MarkdownRenderer githubAlerts>
                    {selectedReport.content}
                  </MarkdownRenderer>
                </div>
              ) : selectedReport.error ? (
                <p className="text-sm text-destructive">{selectedReport.error}</p>
              ) : (
                <p className="text-sm text-muted-foreground">
                  This report does not have rendered Markdown content.
                </p>
              )}
            </CardContent>
          </>
        </Card>
      ) : (
        unavailable
      )}
    </div>
  );
}

export function SubmissionDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const submissionQuery = useQuery({
    queryKey: ["submission", id],
    queryFn: () => api.getSubmission(id!),
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
  const attemptsQuery = useQuery({
    queryKey: ["submission-runs", id],
    queryFn: () => api.getSubmissionRuns(id!),
    enabled: Boolean(id),
    refetchInterval:
      submissionQuery.data?.readiness === "done" ||
      submissionQuery.data?.readiness === "failed" ||
      submissionQuery.data?.readiness === "blocked"
        ? false
        : 5_000,
  });
  const reportsQuery = useQuery({
    queryKey: ["submission-reports", id],
    queryFn: () => api.getSubmissionReports(id!),
    enabled: Boolean(id),
    refetchInterval:
      submissionQuery.data?.readiness === "done" ||
      submissionQuery.data?.readiness === "failed" ||
      submissionQuery.data?.readiness === "blocked"
        ? false
        : 5_000,
  });
  const retry = useMutation({
    mutationFn: () =>
      api.retrySubmission(
        submissionQuery.data!.submissionId,
        submissionQuery.data!.submissionRunId,
      ),
    onSuccess: () => {
      toast.success("Report generation restarted");
      void queryClient.invalidateQueries({ queryKey: ["submission", id] });
      void queryClient.invalidateQueries({ queryKey: ["submission-runs", id] });
      void queryClient.invalidateQueries({ queryKey: ["submission-reports", id] });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : "Retry failed");
    },
  });

  const submission = submissionQuery.data;
  const attempts = attemptsQuery.data?.runs ?? [];
  const selectedAttemptId =
    searchParams.get("attempt") ?? submission?.submissionRunId ?? "";
  const selectedAttempt =
    attempts.find((attempt) => attempt._id === selectedAttemptId) ??
    attempts.find((attempt) => attempt._id === submission?.submissionRunId);
  const isCurrentAttempt =
    selectedAttempt?._id === submission?.submissionRunId;
  const readiness =
    submission && selectedAttempt
      ? isCurrentAttempt
        ? submission.readiness
        : deriveAttemptReadiness(selectedAttempt)
      : "waiting";
  const reports = reportsQuery.data ?? [];
  const requestedTab = searchParams.get("tab");
  const activeTab: SubmissionTab =
    requestedTab === "reports" ||
    requestedTab === "runs" ||
    requestedTab === "processing"
      ? requestedTab
      : submission?.report?.reportId || reports.length > 0
        ? "reports"
        : "runs";

  const requestedReportId = searchParams.get("report");
  const defaultReportId =
    selectedAttempt?.report?.reportId ??
    (isCurrentAttempt ? submission?.report?.reportId : undefined);
  const selectedReport =
    reports.find((report) => reportId(report) === requestedReportId) ??
    reports.find((report) => reportId(report) === defaultReportId) ??
    reports.find((report) => report.submissionRunId === selectedAttempt?._id);

  const memberRows = useMemo<SubmissionMemberRow[]>(() => {
    if (!submission || !selectedAttempt) return [];
    const summaryById = new Map(
      submission.requests.map((request) => [request.requestId, request]),
    );
    return selectedAttempt.requests.map((reference) => {
      const summary = summaryById.get(reference.requestId);
      return {
        requestId: reference.requestId,
        runId: reference.runId,
        task: summary?.task ?? "Unknown task",
        status:
          isCurrentAttempt && summary?.runId === reference.runId
            ? summary.status
            : "historical",
        ...(isCurrentAttempt &&
        summary?.runId === reference.runId &&
        summary.outcome
          ? { outcome: summary.outcome }
          : {}),
        workerType: summary?.workerType ?? "unknown",
        ...(summary?.model ? { model: summary.model } : {}),
        ...(summary?.profileId ? { profileId: summary.profileId } : {}),
        dependencyStates: selectedAttempt.dependencyProjection
          .filter(
            (dependency) =>
              dependency.requestId === reference.requestId &&
              dependency.runId === reference.runId,
          )
          .map((dependency) => ({
            handlerId: dependency.handlerId,
            state: dependency.state,
          })),
        historical: !isCurrentAttempt,
      };
    });
  }, [isCurrentAttempt, selectedAttempt, submission]);

  const memberColumns = useMemo<DataTableColumn<SubmissionMemberRow>[]>(
    () => [
      {
        id: "request",
        header: "Request",
        width: "130px",
        cell: (row) => (
          <Link
            to={`/runs/${row.requestId}?runId=${row.runId}&fromSubmission=${submission?.submissionId ?? ""}`}
            className="font-mono text-primary hover:underline"
            onClick={(event) => event.stopPropagation()}
          >
            <ShortId id={row.requestId} label="request ID" />
          </Link>
        ),
      },
      {
        id: "run",
        header: "Exact run attempt",
        width: "150px",
        cell: (row) => <ShortId id={row.runId} label="run attempt ID" />,
      },
      {
        id: "task",
        header: "Task",
        cell: (row) => <span className="line-clamp-2">{row.task}</span>,
      },
      {
        id: "status",
        header: "Status",
        width: "110px",
        cell: (row) => (
          <Badge variant={row.status === "historical" ? "secondary" : "outline"}>
            {row.status}
          </Badge>
        ),
      },
      {
        id: "outcome",
        header: "Outcome",
        width: "110px",
        cell: (row) =>
          row.outcome ? (
            <Badge
              variant={row.outcome === "succeeded" ? "success" : "destructive"}
            >
              {row.outcome}
            </Badge>
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      },
      {
        id: "worker",
        header: "Worker / model",
        cell: (row) => (
          <div className="text-xs">
            <div>{row.workerType}</div>
            {row.model && (
              <div className="text-muted-foreground">{row.model}</div>
            )}
          </div>
        ),
      },
      {
        id: "dependencies",
        header: "Dependencies",
        cell: (row) =>
          row.dependencyStates.length > 0 ? (
            <div className="flex flex-wrap gap-1">
              {row.dependencyStates.map((dependency) => (
                <Badge
                  key={dependency.handlerId}
                  variant={
                    dependency.state === "failed" ||
                    dependency.state === "blocked"
                      ? "destructive"
                      : "outline"
                  }
                >
                  {submissionHandlerLabel(dependency.handlerId)} ·{" "}
                  {dependency.state}
                </Badge>
              ))}
            </div>
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      },
      {
        id: "open",
        header: "",
        width: "44px",
        align: "right",
        cell: () => <ArrowRight className="ml-auto h-4 w-4 text-muted-foreground" />,
      },
    ],
    [submission?.submissionId],
  );

  const logUrlBuilder = useCallback(
    (_attemptId: string, fromStart: boolean) =>
      api.submissionRunLogsUrl(id!, selectedAttemptId, fromStart),
    [id, selectedAttemptId],
  );
  const logStream = useLogStream({
    id: selectedAttemptId,
    enabled: Boolean(id && selectedAttemptId && activeTab === "processing"),
    fromStart: true,
    attemptNumber: selectedAttempt?.attemptNumber,
    urlBuilder: logUrlBuilder,
  });

  if (submissionQuery.isLoading || attemptsQuery.isLoading) {
    return (
      <div className="p-6 text-sm text-muted-foreground">
        Loading submission…
      </div>
    );
  }
  if (submissionQuery.isError || !submission) {
    return (
      <div className="p-6">
        <p className="text-destructive">Submission could not be loaded.</p>
      </div>
    );
  }
  if (!selectedAttempt) {
    return (
      <div className="p-6">
        <p className="text-destructive">Submission attempt could not be loaded.</p>
      </div>
    );
  }

  const statusSubmission: Submission = {
    ...submission,
    submissionRunId: selectedAttempt._id,
    attemptNumber: selectedAttempt.attemptNumber,
    readiness,
    dependencyProjection: selectedAttempt.dependencyProjection,
    blocking: selectedAttempt.blocking,
    handlerProgress: selectedAttempt.handlerStatus,
    report: selectedAttempt.report,
    requests: memberRows,
  };

  const setTab = (tab: SubmissionTab) => {
    const next = new URLSearchParams(searchParams);
    next.set("tab", tab);
    setSearchParams(next, { replace: true });
  };
  const selectAttempt = (attemptId: string) => {
    const next = new URLSearchParams(searchParams);
    if (attemptId === submission.submissionRunId) next.delete("attempt");
    else next.set("attempt", attemptId);
    next.delete("report");
    setSearchParams(next, { replace: true });
  };
  const selectReport = (report: Report) => {
    const next = new URLSearchParams(searchParams);
    next.set("tab", "reports");
    next.set("report", reportId(report));
    if (
      report.submissionRunId &&
      report.submissionRunId !== submission.submissionRunId
    ) {
      next.set("attempt", report.submissionRunId);
    } else {
      next.delete("attempt");
    }
    setSearchParams(next, { replace: true });
  };

  return (
    <div className="mx-auto w-full max-w-7xl space-y-5 p-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <Button variant="ghost" size="sm" asChild className="-ml-3 mb-2">
            <Link to="/runs">
              <ArrowLeft className="mr-2 h-4 w-4" />
              Runs
            </Link>
          </Button>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-semibold">Submission</h1>
            <ShortId id={submission.submissionId} label="submission ID" />
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            Created {formatDate(submission.createdAt)} · {submission.requests.length}{" "}
            member run{submission.requests.length === 1 ? "" : "s"}
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <SubmissionAttemptPicker
            attempts={attempts}
            currentAttemptId={submission.submissionRunId}
            selectedAttemptId={selectedAttempt._id}
            onSelect={selectAttempt}
          />
          <Button
            variant="outline"
            onClick={() => retry.mutate()}
            disabled={
              !isCurrentAttempt ||
              retry.isPending ||
              submission.readiness === "waiting" ||
              submission.readiness === "blocked" ||
              submission.readiness === "processing"
            }
          >
            <RotateCcw className="mr-2 h-4 w-4" />
            Retry report generation
          </Button>
        </div>
      </div>

      {!isCurrentAttempt && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-4 py-2 text-sm text-amber-700 dark:text-amber-400">
          <Clock className="h-4 w-4 shrink-0" />
          <span>
            Viewing attempt {selectedAttempt.attemptNumber} (historical and
            read-only).
          </span>
          <button
            type="button"
            className="font-medium underline hover:no-underline"
            onClick={() => selectAttempt(submission.submissionRunId)}
          >
            View current attempt
          </button>
        </div>
      )}

      <Tabs value={activeTab} onValueChange={(value) => setTab(value as SubmissionTab)}>
        <TabsList>
          <TabsTrigger value="reports" className="gap-1.5">
            <FileText className="h-4 w-4" />
            Reports {reports.length > 0 ? `(${reports.length})` : ""}
          </TabsTrigger>
          <TabsTrigger value="runs" className="gap-1.5">
            <ListChecks className="h-4 w-4" />
            Runs ({memberRows.length})
          </TabsTrigger>
          <TabsTrigger value="processing" className="gap-1.5">
            <ScrollText className="h-4 w-4" />
            Processing
          </TabsTrigger>
        </TabsList>

        <TabsContent value="reports" className="mt-4">
          <SubmissionReports
            reports={reports}
            selectedReport={selectedReport}
            currentReportId={submission.report?.reportId}
            selectedAttempt={selectedAttempt}
            readiness={readiness}
            onSelect={selectReport}
            onShowProcessing={() => setTab("processing")}
          />
        </TabsContent>

        <TabsContent value="runs" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">
                Immutable member run vector
              </CardTitle>
              <p className="text-sm text-muted-foreground">
                Each row preserves the exact request and run-attempt identity for
                submission attempt {selectedAttempt.attemptNumber}.
              </p>
            </CardHeader>
            <CardContent>
              <DataTable
                items={memberRows}
                columns={memberColumns}
                getRowId={(row) => `${row.requestId}:${row.runId}`}
                density="compact"
                onRowClick={(row) =>
                  navigate(
                    `/runs/${row.requestId}?runId=${row.runId}&fromSubmission=${submission.submissionId}`,
                  )
                }
                emptyState={
                  <div className="py-8 text-center text-sm text-muted-foreground">
                    This attempt has no member runs.
                  </div>
                }
              />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="processing" className="mt-4 space-y-4">
          <SubmissionStatusCard submission={statusSubmission} />

          {selectedAttempt.blocking.length > 0 && (
            <Card className="border-destructive/40">
              <CardHeader>
                <CardTitle className="text-base">Blocking dependencies</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {selectedAttempt.blocking.map((blocking) => (
                  <div
                    key={`${blocking.requestId}:${blocking.runId}:${blocking.handlerId}`}
                    className="flex flex-wrap items-center gap-2 rounded-md border p-3 text-sm"
                  >
                    <span className="font-medium">
                      {submissionHandlerLabel(blocking.handlerId)}
                    </span>
                    <Badge variant="destructive">
                      {blocking.reason.replaceAll("-", " ")}
                    </Badge>
                    <Link
                      to={`/runs/${blocking.requestId}?runId=${blocking.runId}&fromSubmission=${submission.submissionId}`}
                      className="font-mono text-primary hover:underline"
                    >
                      request {blocking.requestId.slice(0, 8)}
                    </Link>
                    <span className="font-mono text-xs text-muted-foreground">
                      run {blocking.runId}
                    </span>
                    {blocking.error && (
                      <span className="w-full text-xs text-destructive">
                        {blocking.error}
                      </span>
                    )}
                  </div>
                ))}
              </CardContent>
            </Card>
          )}

          {selectedAttempt.handlerStatus &&
            Object.keys(selectedAttempt.handlerStatus).length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Processing stages</CardTitle>
                </CardHeader>
                <CardContent className="flex flex-wrap gap-2">
                  {Object.entries(selectedAttempt.handlerStatus).map(
                    ([handlerId, status]) => (
                      <Badge
                        key={handlerId}
                        variant={
                          status.status === "failed"
                            ? "destructive"
                            : status.status === "done"
                              ? "success"
                              : "outline"
                        }
                      >
                        {submissionHandlerLabel(handlerId)} · {status.status}
                      </Badge>
                    ),
                  )}
                </CardContent>
              </Card>
            )}

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Attempt processing logs</CardTitle>
            </CardHeader>
            <CardContent>
              <LogViewer
                runId={selectedAttempt._id}
                enabled
                logs={logStream.logs}
                isConnected={
                  readiness === "waiting" ||
                  readiness === "ready" ||
                  readiness === "processing"
                    ? logStream.isConnected
                    : false
                }
                isDone={logStream.isDone}
                error={logStream.error}
              />
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
