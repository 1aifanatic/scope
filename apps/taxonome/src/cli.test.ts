// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

/** Runs real child processes so stdout/stderr and caller-working-directory contracts are covered. */
const exec = promisify(execFile);
const root = fileURLToPath(new URL("../../../", import.meta.url));
const ANSI_PATTERN = /\u001b\[[0-9;]*m/;

/** Returns an environment with all inherited authentication removed. */
function childEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    COPILOT_GITHUB_TOKEN: "",
    GH_TOKEN: "",
    GITHUB_TOKEN: "",
    ...overrides,
  };
}

describe("standalone CLI process contract", () => {
  it("runs minimal-context deterministic ATIF without tokens or Scope services, stdout is JSON only", async () => {
    const { stdout, stderr } = await exec(
      process.execPath,
      [
        "--conditions=source",
        "--import",
        "tsx",
        "apps/taxonome/src/index.ts",
        "run",
        "packages/taxonomy-evaluation/fixtures/timeout.atif.json",
        "--context",
        "packages/taxonomy-evaluation/fixtures/minimal-context.json",
        "--elements",
        "beh-timeout",
      ],
      { cwd: root, env: childEnvironment() }
    );
    const output: unknown = JSON.parse(stdout);
    expect(output).toMatchObject({ results: [{ implementation: "deterministic", result: { state: "completed", observed: true } }] });
    expect(stderr).toBe("");
  });
  it("reports input/configuration errors on stderr with no success-shaped stdout", async () => {
    const command = exec(
      process.execPath,
      [
        "--conditions=source",
        "--import",
        "tsx",
        "apps/taxonome/src/index.ts",
        "run",
        "missing.json",
        "--context",
        "missing.json"
      ],
      { cwd: root }
    );
    await expect(command).rejects.toMatchObject({ code: 1, stdout: "", stderr: expect.stringContaining("taxonome:") });
  });
  it("does not initialize SDK/auth/ledger for a known incomplete-run precondition", async () => {
    const { stdout, stderr } = await exec(
      process.execPath,
      [
        "--conditions=source",
        "--import",
        "tsx",
        "apps/taxonome/src/index.ts",
        "run",
        "packages/taxonomy-evaluation/fixtures/timeout.atif.json",
        "--context",
        "packages/taxonomy-evaluation/fixtures/partial-context.json",
        "--elements",
        "beh-skipped-invocation",
      ],
      { cwd: root, env: childEnvironment() }
    );
    const output: unknown = JSON.parse(stdout);
    expect(output).toMatchObject({
      results: [{ result: { state: "indeterminate" } }],
      metadata: { initialized: false, budget: null }
    });
    expect(stderr).toBe("");
  });
  it("preserves caller cwd and JSON stdout through the repository-root script", async () => {
    const { stdout, stderr } = await exec(
      "pnpm",
      [
        "--silent",
        "taxonome",
        "run",
        "packages/taxonomy-evaluation/fixtures/timeout.atif.json",
        "--context",
        "packages/taxonomy-evaluation/fixtures/minimal-context.json",
        "--elements",
        "beh-timeout",
      ],
      { cwd: root, env: childEnvironment() }
    );
    const output: unknown = JSON.parse(stdout);
    expect(output).toMatchObject({ results: [{ result: { observed: true } }] });
    expect(stderr).toBe("");
  });
  it("runs bounded HTTP ATIF acquisition through the same deterministic CLI path without credentials", async () => {
    // Serve the committed ATIF over loopback and verify the child receives no inherited auth headers.
    const body = await readFile(new URL("../../../packages/taxonomy-evaluation/fixtures/timeout.atif.json", import.meta.url));
    const server = createServer((req, res) => {
      expect(req.headers.authorization).toBeUndefined();
      res.setHeader("Content-Type", "application/json");
      res.end(body);
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing local fixture listener");
    try {
      const { stdout, stderr } = await exec(
        process.execPath,
        [
          "--conditions=source",
          "--import",
          "tsx",
          "apps/taxonome/src/index.ts",
          "run",
          `http://127.0.0.1:${address.port}/atif`,
          "--context",
          "packages/taxonomy-evaluation/fixtures/minimal-context.json",
          "--elements",
          "beh-timeout",
        ],
        { cwd: root, env: childEnvironment() }
      );
      const output: unknown = JSON.parse(stdout);
      expect(output).toMatchObject({ results: [{ result: { observed: true } }] });
      expect(stderr).toBe("");
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close(e => e ? reject(e) : resolve());
        server.closeAllConnections();
      });
    }
  });

  it("keeps redirected help and errors plain while preserving accessible text", async () => {
    const help = await exec(
      process.execPath,
      ["--conditions=source", "--import", "tsx", "apps/taxonome/src/index.ts", "--help"],
      { cwd: root, env: childEnvironment() },
    );
    expect(help.stdout).toBe("");
    expect(help.stderr).toContain("Usage:");
    expect(help.stderr).not.toMatch(ANSI_PATTERN);

    const error = exec(
      process.execPath,
      ["--conditions=source", "--import", "tsx", "apps/taxonome/src/index.ts", "run", "missing.json", "--context", "missing.json"],
      { cwd: root, env: childEnvironment({ NO_COLOR: "1", FORCE_COLOR: "1" }) },
    );
    await expect(error).rejects.toMatchObject({
      code: 1,
      stdout: "",
      stderr: expect.stringContaining("taxonome:"),
    });
    await expect(error).rejects.toMatchObject({
      stderr: expect.not.stringMatching(ANSI_PATTERN),
    });
  });

  it("keeps JSON stdout ANSI-free even when FORCE_COLOR enables diagnostic color", async () => {
    const { stdout } = await exec(
      process.execPath,
      [
        "--conditions=source",
        "--import",
        "tsx",
        "apps/taxonome/src/index.ts",
        "run",
        "packages/taxonomy-evaluation/fixtures/timeout.atif.json",
        "--context",
        "packages/taxonomy-evaluation/fixtures/minimal-context.json",
        "--elements",
        "beh-timeout",
      ],
      { cwd: root, env: childEnvironment({ FORCE_COLOR: "1" }) },
    );

    expect(stdout).not.toMatch(ANSI_PATTERN);
    expect(() => JSON.parse(stdout) as unknown).not.toThrow();
  });
});
