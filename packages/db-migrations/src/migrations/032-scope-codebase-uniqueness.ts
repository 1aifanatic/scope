// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import type { Db } from "mongodb";
import type { MigrationInterface } from "mongo-migrate-ts";

export class ScopeCodebaseUniqueness implements MigrationInterface {
  async up(db: Db): Promise<void> {
    const indexes = [
      { collection: "codebases", key: "slug", name: "uniq_project_codebase_slug" },
      { collection: "codebase-revisions", key: "ref", name: "uniq_project_codebase_ref" },
    ];
    // Verify both replacements before removing either old constraint. Cosmos
    // deployments that cannot add these unique indexes require operator repair.
    for (const index of indexes) {
      const collection = db.collection(index.collection);
      const key = { projectId: 1, [index.key]: 1 };
      try {
        await collection.createIndex(key, { name: index.name, unique: true });
        const actual = (await collection.listIndexes().toArray()).find(candidate => candidate.name === index.name);
        if (!actual || actual.unique !== true || actual.sparse || actual.partialFilterExpression ||
          JSON.stringify(actual.key) !== JSON.stringify(key)) throw new Error("Required unique index was not installed");
      } catch (error) {
        throw new Error(`[032] Cannot enforce ${index.collection} project uniqueness; operator repair required`, { cause: error });
      }
    }
    for (const index of indexes) {
      const collection = db.collection(index.collection);
      for (const old of await collection.listIndexes().toArray()) {
        if (old.unique && old.name && JSON.stringify(old.key) === JSON.stringify({ [index.key]: 1 })) {
          await collection.dropIndex(old.name);
        }
      }
    }
    console.log("[032] Verified project-local codebase slug/ref uniqueness");
  }
  async down(): Promise<void> {
    console.log("[032-down] Retaining project uniqueness; global indexes cannot represent colliding project slugs");
  }
}
