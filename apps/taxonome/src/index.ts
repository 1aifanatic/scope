#!/usr/bin/env node
// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { createCli } from "./cli.js";

try { await createCli().parseAsync(process.argv); }
catch (error) {
  const messages = error instanceof AggregateError
    ? [error.message, ...error.errors.map(e => e instanceof Error ? e.message : String(e))]
    : [error instanceof Error ? error.message : String(error)];
  process.stderr.write(`taxonome: ${messages.join("; ")}\n`);
  process.exitCode = 1;
}
