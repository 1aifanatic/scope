// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { randomUUID } from "node:crypto";
import { MongoClient, type Db } from "mongodb";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CreateProjectMemberships } from "./migrations/031-create-project-memberships.js";

const uri = process.env.AUTH_TEST_MONGO_URI;
describe.skipIf(!uri)("Native Mongo membership authority migration", () => {
  let client: MongoClient;
  let db: Db;
  beforeEach(async () => {
    client = await MongoClient.connect(uri!);
    db = client.db(`rbac_membership_test_${randomUUID().replaceAll("-", "")}`);
  });
  afterEach(async () => { await db.dropDatabase(); await client.close(); });

  it("reruns without inventing grants and retains uniqueness after revoke/regrant", async () => {
    const migration = new CreateProjectMemberships();
    await migration.up(db);
    await migration.up(db);
    const members = db.collection("project_memberships");
    expect(await members.countDocuments()).toBe(0);
    await members.insertOne({ projectId: "a", userId: "bob", role: "reader", revision: 1 });
    await members.updateOne({ projectId: "a", userId: "bob", revision: 1 }, { $set: { revokedAt: new Date(), revision: 2 } });
    await expect(members.insertOne({ projectId: "a", userId: "bob", role: "admin" })).rejects.toMatchObject({ code: 11000 });
    await members.updateOne({ projectId: "a", userId: "bob", revision: 2 }, { $set: { role: "contributor", revision: 3 }, $unset: { revokedAt: "" } });
    expect(await members.countDocuments({ projectId: "a", userId: "bob" })).toBe(1);
    expect(await members.findOne({ projectId: "a", userId: "bob" })).toMatchObject({ role: "contributor", revision: 3 });
    expect((await db.collection("admin_operations").listIndexes().toArray()).some(index => "expireAfterSeconds" in index)).toBe(false);
  });

  it("fails closed rather than silently accepting automatic administrative-evidence pruning", async () => {
    await db.collection("admin_operations").createIndex({ createdAt: 1 }, { expireAfterSeconds: 86400 });
    await expect(new CreateProjectMemberships().up(db)).rejects.toThrow("TTL index");
    expect(await db.collection("admin_operations").listIndexes().toArray()).toEqual(expect.arrayContaining([
      expect.objectContaining({ expireAfterSeconds: 86400 }),
    ]));
  });
});
