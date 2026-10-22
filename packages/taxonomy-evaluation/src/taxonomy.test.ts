// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createBuiltInHandlerRegistry } from "./handlers.js";
import {
  loadTaxonomy,
  serializableTaxonomy,
  taxonomyDigest,
} from "./taxonomy.js";

const directories: string[] = [];

/** Creates one owned temporary taxonomy project. */
async function tempProject(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "taxonome-taxonomy-"));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory =>
    rm(directory, { recursive: true, force: true })
  ));
});

const timeoutElement = `
id: beh-timeout
label: Timeout
category_id: invocation
implementation:
  type: deterministic
  handler: scope/timeout-v1
  config:
    threshold_ms: 2500
evidence:
  complete_for_negative: false
output_schema:
  type: object
  additionalProperties: true
`;

describe("scope/taxonomy/v1 loader", () => {
  it("normalizes embedded and referenced elements to the same canonical digest", async () => {
    const root = await tempProject();
    await mkdir(join(root, "elements"));
    await writeFile(join(root, "elements", "timeout.yaml"), timeoutElement);
    await writeFile(join(root, "referenced.yaml"), `
schema_version: scope/taxonomy/v1
id: behavior
version: 1.0.0
surfaces:
  - id: surface-mcp
    label: MCP
elements:
  - path: elements/timeout.yaml
`);
    await writeFile(join(root, "embedded.yaml"), `
version: 1.0.0
id: behavior
schema_version: scope/taxonomy/v1
elements:
  - ${timeoutElement.trim().replaceAll("\n", "\n    ")}
surfaces:
  - label: MCP
    id: surface-mcp
`);

    const handlers = createBuiltInHandlerRegistry();
    const referenced = await loadTaxonomy(join(root, "referenced.yaml"), { handlers });
    const embedded = await loadTaxonomy(join(root, "embedded.yaml"), {
      handlers: createBuiltInHandlerRegistry(),
    });

    expect(referenced.digest).toBe(embedded.digest);
    expect(serializableTaxonomy(referenced)).toEqual(serializableTaxonomy(embedded));
    expect(referenced.elementById.get("beh-timeout")).toMatchObject({
      implementation: {
        type: "deterministic",
        handler: "scope/timeout-v1",
        config: { threshold_ms: 2500 },
      },
    });
  });

  it("loads the production taxonomy and resolves both implementation strategies", async () => {
    const taxonomy = await loadTaxonomy(
      new URL("../taxonomies/agent-behavior/taxonomy.yaml", import.meta.url).pathname,
      { handlers: createBuiltInHandlerRegistry() },
    );

    expect(taxonomy.schema_version).toBe("scope/taxonomy/v1");
    expect(taxonomy.elements.map(element => [element.id, element.implementation.type]))
      .toEqual([
        ["beh-skipped-invocation", "prompt"],
        ["beh-timeout", "deterministic"],
      ]);
    expect(taxonomy.elementById.get("beh-timeout")?.resolvedHandler).toBeDefined();
  });

  it("rejects traversal, symlink escape, aliases, duplicates, unknown handlers, and invalid schemas", async () => {
    const root = await tempProject();
    const outside = await tempProject();
    await writeFile(join(outside, "outside.yaml"), timeoutElement);
    await symlink(join(outside, "outside.yaml"), join(root, "linked.yaml"));

    const manifest = (elements: string) => `
schema_version: scope/taxonomy/v1
id: behavior
version: 1.0.0
surfaces:
  - id: surface-mcp
    label: MCP
elements:
${elements}
`;

    await writeFile(join(root, "traversal.yaml"), manifest("  - path: ../outside.yaml"));
    await expect(loadTaxonomy(join(root, "traversal.yaml"), {
      handlers: createBuiltInHandlerRegistry(),
    })).rejects.toThrow("Unsafe taxonomy element path");

    await writeFile(join(root, "symlink.yaml"), manifest("  - path: linked.yaml"));
    await expect(loadTaxonomy(join(root, "symlink.yaml"), {
      handlers: createBuiltInHandlerRegistry(),
    })).rejects.toThrow("cannot be a symlink");

    await writeFile(join(root, "alias.yaml"), `
schema_version: scope/taxonomy/v1
id: behavior
version: 1.0.0
surfaces: &surfaces
  - id: surface-mcp
    label: MCP
elements: *surfaces
`);
    await expect(loadTaxonomy(join(root, "alias.yaml"), {
      handlers: createBuiltInHandlerRegistry(),
    })).rejects.toThrow(/anchors|aliases/);

    await writeFile(join(root, "duplicate.yaml"), manifest(
      `  - ${timeoutElement.trim().replaceAll("\n", "\n    ")}\n  - ${timeoutElement.trim().replaceAll("\n", "\n    ")}`,
    ));
    await expect(loadTaxonomy(join(root, "duplicate.yaml"), {
      handlers: createBuiltInHandlerRegistry(),
    })).rejects.toThrow("Duplicate taxonomy element ID");

    await writeFile(join(root, "unknown.yaml"), manifest(`
  - id: custom
    label: Custom
    implementation:
      type: deterministic
      handler: acme/missing-v1
    output_schema:
      type: object
`));
    await expect(loadTaxonomy(join(root, "unknown.yaml"), {
      handlers: createBuiltInHandlerRegistry(),
    })).rejects.toThrow("Unknown deterministic handler");

    await writeFile(join(root, "schema.yaml"), manifest(`
  - id: custom
    label: Custom
    implementation:
      type: prompt
      prompt: Test.
    output_schema:
      $ref: https://example.invalid/schema
`));
    await expect(loadTaxonomy(join(root, "schema.yaml"), {
      handlers: createBuiltInHandlerRegistry(),
    })).rejects.toThrow();
  });

  it("canonical digest ignores object key order but includes semantic fields", () => {
    expect(taxonomyDigest({ b: 2, a: { d: 4, c: 3 } }))
      .toBe(taxonomyDigest({ a: { c: 3, d: 4 }, b: 2 }));
    expect(taxonomyDigest({ prompt: "A" })).not.toBe(taxonomyDigest({ prompt: "B" }));
  });
});
