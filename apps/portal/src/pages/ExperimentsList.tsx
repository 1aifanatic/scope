// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { FlaskConical, Plus } from "lucide-react";
import { Link } from "react-router-dom";
import { ShortId } from "@/components/ShortId";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { api } from "@/lib/api";
import { formatDate } from "@/lib/utils";

export function ExperimentsList() {
  const [cursor, setCursor] = useState<string>();
  const experimentsQuery = useQuery({
    queryKey: ["experiments", cursor],
    queryFn: () => api.listExperiments({ cursor, limit: 50 }),
  });

  return (
    <div className="mx-auto w-full max-w-6xl space-y-6 p-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Experiments</h1>
          <p className="text-muted-foreground">
            Reproducible benchmark compositions and their processing history.
          </p>
        </div>
        <Button asChild>
          <Link to="/experiments/new">
            <Plus className="mr-2 h-4 w-4" />
            New Experiment
          </Link>
        </Button>
      </div>

      {experimentsQuery.isLoading && (
        <p className="text-sm text-muted-foreground">Loading experiments…</p>
      )}
      {experimentsQuery.isError && (
        <p className="text-sm text-destructive">
          {experimentsQuery.error instanceof Error
            ? experimentsQuery.error.message
            : "Experiments could not be loaded."}
        </p>
      )}
      {experimentsQuery.data?.items.length === 0 && (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
            <FlaskConical className="h-8 w-8 text-muted-foreground" />
            <div>
              <p className="font-medium">No experiments yet</p>
              <p className="text-sm text-muted-foreground">
                Create one from a run configuration or start explicitly empty.
              </p>
            </div>
          </CardContent>
        </Card>
      )}
      <div className="grid gap-4">
        {experimentsQuery.data?.items.map((experiment) => (
          <Link
            key={experiment.experimentId}
            to={`/experiments/${experiment.experimentId}`}
          >
            <Card className="transition-colors hover:bg-muted/30">
              <CardHeader className="flex-row items-start justify-between space-y-0">
                <div>
                  <CardTitle className="text-base">
                    {experiment.metadata.name}
                  </CardTitle>
                  <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                    <ShortId
                      id={experiment.experimentId}
                      label="experiment ID"
                    />
                    <span>Created {formatDate(experiment.createdAt)}</span>
                  </div>
                </div>
                <Badge
                  variant={
                    experiment.readiness === "failed" ||
                    experiment.readiness === "blocked"
                      ? "destructive"
                      : "secondary"
                  }
                >
                  {experiment.readiness ?? "unknown"}
                </Badge>
              </CardHeader>
              <CardContent className="flex flex-wrap gap-4 text-sm">
                <span>{experiment.revision.memberCount} runs</span>
                <span>Revision {experiment.revision.revisionNumber}</span>
                <span>Attempt {experiment.execution.attemptNumber}</span>
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>

      {experimentsQuery.data?.nextCursor && (
        <div className="flex justify-end">
          <Button
            variant="outline"
            onClick={() => setCursor(experimentsQuery.data?.nextCursor)}
          >
            Next page
          </Button>
        </div>
      )}
    </div>
  );
}
