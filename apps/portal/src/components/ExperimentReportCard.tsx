// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { Download, ExternalLink } from "lucide-react";
import { Link } from "react-router-dom";
import { MarkdownRenderer } from "@/components/MarkdownRenderer";
import { ReportStatusBadge } from "@/components/ReportStatusBadge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { Report } from "@/types";

interface ExperimentReportCardProps {
  experimentId: string;
  experimentExecutionId: string;
  attemptNumber?: number;
  report?: Report;
  structuredUrl?: string;
  isLoading?: boolean;
  error?: string;
  isProcessing?: boolean;
  onRetry?: () => void;
}

export function ExperimentReportCard({
  experimentId,
  experimentExecutionId,
  attemptNumber,
  report,
  structuredUrl,
  isLoading,
  error,
  isProcessing,
  onRetry,
}: ExperimentReportCardProps) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-4">
        <div>
          <CardTitle className="text-base">Reports</CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">
            Attempt {attemptNumber ?? "…"} ·{" "}
            <span className="font-mono">{experimentExecutionId}</span>
          </p>
        </div>
        {report && (
          <div className="flex items-center gap-2">
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
          </div>
        )}
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
