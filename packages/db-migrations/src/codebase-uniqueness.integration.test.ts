// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { randomUUID } from "node:crypto";
import { MongoClient, type Db } from "mongodb";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ScopeCodebaseUniqueness } from "./migrations/032-scope-codebase-uniqueness.js";

const uri = process.env.AUTH_TEST_MONGO_URI;
describe.skipIf(!uri)("Native Mongo codebase uniqueness migration", () => {
  let client: MongoClient;
  let db: Db;
  beforeEach(async () => {
    client = await MongoClient.connect(uri!);
    db = client.db(`rbac_codebase_test_${randomUUID().replaceAll("-", "")}`);
  });
  afterEach(async () => { await db.dropDatabase(); await client.close(); });
  it("reruns safely, allows cross-project collisions and rejects same-project duplicates", async () => {
    await db.collection("codebases").createIndex({ slug: 1 }, { unique: true });
    await db.collection("codebase-revisions").createIndex({ ref: 1 }, { unique: true });
    const migration = new ScopeCodebaseUniqueness();
    await migration.up(db);
    await migration.up(db);
    await db.collection("codebases").insertMany([{ projectId: "a", slug: "same" }, { projectId: "b", slug: "same" }]);
    await db.collection("codebase-revisions").insertMany([{ projectId: "a", ref: "same@r1" }, { projectId: "b", ref: "same@r1" }]);
    await expect(db.collection("codebases").insertOne({ projectId: "a", slug: "same" })).rejects.toMatchObject({ code: 11000 });
    await expect(db.collection("codebase-revisions").insertOne({ projectId: "a", ref: "same@r1" })).rejects.toMatchObject({ code: 11000 });
  });
  it("fails closed on incompatible legacy data without dropping the existing constraint", async () => {
    await db.collection("codebases").createIndex({ slug: 1 }, { unique: true });
    await db.collection("codebase-revisions").insertMany([{ projectId: "a", ref: "same@r1" }, { projectId: "a", ref: "same@r1" }]);
    await expect(new ScopeCodebaseUniqueness().up(db)).rejects.toThrow("operator repair required");
    expect(await db.collection("codebases").listIndexes().toArray()).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: { slug: 1 }, unique: true }),
    ]));
  });
});
