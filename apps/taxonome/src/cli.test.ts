// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
const exec = promisify(execFile);
const root = fileURLToPath(new URL("../../../", import.meta.url));
describe("standalone CLI process contract", () => {
  it("runs minimal-context deterministic ATIF without tokens or Scope services, stdout is JSON only", async () => {
    const { stdout, stderr } = await exec(process.execPath, [
      "--conditions=source", "--import", "tsx", "apps/taxonome/src/index.ts",
      "run", "packages/taxonomy-evaluation/fixtures/timeout.atif.json",
      "--context", "packages/taxonomy-evaluation/fixtures/minimal-context.json", "--elements", "beh-timeout",
    ], { cwd: root, env: { ...process.env, COPILOT_GITHUB_TOKEN: "", GH_TOKEN: "", GITHUB_TOKEN: "" } });
    const output: unknown = JSON.parse(stdout);
    expect(output).toMatchObject({ results: [{ implementation: "deterministic", result: { state: "completed", observed: true } }] });
    expect(stderr).toBe("");
  });
  it("reports input/configuration errors on stderr with no success-shaped stdout", async () => {
    const command = exec(process.execPath, ["--conditions=source", "--import", "tsx", "apps/taxonome/src/index.ts", "run", "missing.json", "--context", "missing.json"], { cwd: root });
    await expect(command).rejects.toMatchObject({ code: 1, stdout: "", stderr: expect.stringContaining("taxonome:") });
  });
});
