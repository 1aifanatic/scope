// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { Download, ExternalLink } from "lucide-react";
import { Link } from "react-router-dom";
import { MarkdownRenderer } from "@/components/MarkdownRenderer";
import { ReportStatusBadge } from "@/components/ReportStatusBadge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type {
  ExperimentReportGroup,
  ExperimentReportSelection,
} from "@/lib/experiment-reports";
import { formatDate } from "@/lib/utils";

interface ExperimentReportCardProps {
  experimentId: string;
  experimentExecutionId: string;
  attemptNumber?: number;
  groups: ExperimentReportGroup[];
  selection?: ExperimentReportSelection;
  structuredUrl?: string;
  isLoading?: boolean;
  error?: string;
  isProcessing?: boolean;
  onReportTypeChange?: (typeKey: string) => void;
  onReportVersionChange?: (reportId: string) => void;
  onRetry?: () => void;
}

export function ExperimentReportCard({
  experimentId,
  experimentExecutionId,
  attemptNumber,
  groups,
  selection,
  structuredUrl,
  isLoading,
  error,
  isProcessing,
  onReportTypeChange,
  onReportVersionChange,
  onRetry,
}: ExperimentReportCardProps) {
  const report = selection?.report;
  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-4">
        <div>
          <CardTitle className="text-base">Reports</CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">
            Attempt {attemptNumber ?? "…"} ·{" "}
            <span className="font-mono">{experimentExecutionId}</span>
          </p>
        </div>
        <div className="flex flex-wrap items-end justify-end gap-2">
          {groups.length > 1 && selection && (
            <div className="space-y-1">
              <label className="block text-xs font-medium text-muted-foreground">
                Report type
              </label>
              <Select
                value={selection.group.key}
                onValueChange={onReportTypeChange}
              >
                <SelectTrigger
                  aria-label="Report type"
                  className="w-[220px]"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent align="end">
                  {groups.map((group) => (
                    <SelectItem key={group.key} value={group.key}>
                      {group.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          {selection && selection.group.reports.length > 1 && (
            <div className="space-y-1">
              <label className="block text-xs font-medium text-muted-foreground">
                Version
              </label>
              <Select
                value={report?._id}
                onValueChange={onReportVersionChange}
              >
                <SelectTrigger
                  aria-label="Report version"
                  className="w-[220px]"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent align="end">
                  {selection.group.reports.map((version, index) => (
                    <SelectItem key={version._id} value={version._id}>
                      Version {selection.group.reports.length - index} ·{" "}
                      {index === 0 ? "Latest" : "Historical"} ·{" "}
                      {formatDate(version.createdAt)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          {report && (
            <>
              <Badge variant={selection?.isLatest ? "default" : "secondary"}>
                {selection?.isLatest ? "Latest" : "Historical"}
              </Badge>
              <ReportStatusBadge status={report.status} />
              {structuredUrl && (
                <Button variant="outline" size="sm" asChild>
                  <a href={structuredUrl} download>
                    <Download className="mr-1 h-3.5 w-3.5" />
                    Structured JSON
                  </a>
                </Button>
              )}
              <Button variant="outline" size="sm" asChild>
                <Link
                  to={`/reports/${report._id}?experimentId=${encodeURIComponent(experimentId)}&experimentExecutionId=${encodeURIComponent(experimentExecutionId)}`}
                >
                  <ExternalLink className="mr-1 h-3.5 w-3.5" />
                  Direct link
                </Link>
              </Button>
            </>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading report…</p>
        ) : error ? (
          <div className="flex items-center gap-3">
            <p className="text-sm text-destructive">{error}</p>
            {onRetry && (
              <Button variant="outline" size="sm" onClick={onRetry}>
                Retry
              </Button>
            )}
          </div>
        ) : report?.status === "failed" ? (
          <p className="text-sm text-destructive">
            {report.error ?? "Readout generation failed."}
          </p>
        ) : report?.content ? (
          <div className="prose max-w-none dark:prose-invert">
            <MarkdownRenderer githubAlerts>{report.content}</MarkdownRenderer>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            {isProcessing
              ? "The report is being generated."
              : "No built-in report is available for this execution."}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
