// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { randomUUID } from "node:crypto";
import { MongoClient, type Db, type Document } from "mongodb";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { AdminOperations, type AdminIntent } from "./admin-operations.js";
import { Authorization } from "./authorization.js";
import { operatorAccess, OperatorAccessInput } from "./operator-access.js";
import { mapLegacyMemberships, LegacyMembershipManifest } from "./legacy-memberships.js";
import { UserStore } from "./user-store.js";
import type { UserDocument } from "shared";

const uri = process.env.AUTH_TEST_MONGO_URI;
describe.runIf(Boolean(uri))("Durable administrative operation failure recovery", () => {
  const database = `rbac-operations-test-${randomUUID()}`;
  let client: MongoClient;
  let db: Db;
  let service: AdminOperations;
  const intent = (overrides: Partial<AdminIntent> = {}): AdminIntent => ({
    _id: randomUUID(), actor: "verified-platform-admin", reason: "Acceptance fixture",
    collection: "project_memberships", targetId: randomUUID(), expectedRevision: 0,
    change: { role: "reader" }, unset: [],
    initial: { userId: randomUUID(), projectId: randomUUID(), createdByUserId: "verified-platform-admin" },
    ...overrides,
  });
  const read = (collection: string, id: string) =>
    db.collection<Document & { _id: string }>(collection).findOne({ _id: id });

  beforeAll(async () => {
    if (!uri) throw new Error("AUTH_TEST_MONGO_URI required");
    client = new MongoClient(uri);
    await client.connect();
    db = client.db(database);
    service = new AdminOperations(db);
    await db.collection("project_memberships").createIndex({ projectId: 1, userId: 1 }, { unique: true });
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => { if (db) await db.dropDatabase(); await client?.close(); });

  function intercept() {
    const original = db.collection.bind(db);
    const operations = original("admin_operations");
    const target = original("project_memberships");
    vi.spyOn(db, "collection").mockImplementation(name =>
      name === "admin_operations" ? operations : name === "project_memberships" ? target : original(name));
    return { operations, target };
  }

  function projectCreation(): AdminIntent {
    return intent({
      collection: "projects", targetId: randomUUID(), initial: {},
      change: { name: "Creator membership fixture" },
      creatorMembershipOperationId: randomUUID(),
    });
  }

  it("audits project creation and grants only its creator one project-admin membership", async () => {
    const creation = projectCreation();
    expect(await service.execute(creation)).toMatchObject({ state: "completed", revision: 1 });
    expect(await service.execute(creation)).toMatchObject({ state: "completed", revision: 1 });
    expect(await read("project_memberships", `${creation.targetId}:${creation.actor}`)).toMatchObject({
      projectId: creation.targetId, userId: creation.actor, role: "admin", revision: 1,
      lastOperationId: creation.creatorMembershipOperationId,
    });
    expect(await read("admin_operations", creation.creatorMembershipOperationId!)).toMatchObject({
      actor: creation.actor, state: "completed", reason: "Project creator project-admin membership",
    });
    expect(await db.collection("project_memberships").countDocuments({ projectId: creation.targetId })).toBe(1);
    expect(await new Authorization(db).memberships(creation.actor)).toEqual(expect.arrayContaining([
      expect.objectContaining({ projectId: creation.targetId, role: "admin" }),
    ]));
  });

  it("writes neither project nor creator membership when the parent intent cannot be persisted", async () => {
    const creation = projectCreation();
    vi.spyOn(intercept().operations, "insertOne").mockRejectedValueOnce(new Error("Intent store unavailable"));
    await expect(service.execute(creation)).rejects.toMatchObject({ status: 503 });
    expect(await read("projects", creation.targetId)).toBeNull();
    expect(await read("project_memberships", `${creation.targetId}:${creation.actor}`)).toBeNull();
  });

  it("keeps the parent pending and resumes both steps if the creator intent cannot be persisted", async () => {
    const creation = projectCreation();
    const { operations } = intercept();
    const insert = operations.insertOne.bind(operations);
    const failure = vi.spyOn(operations, "insertOne").mockImplementation(async (...args) => {
      if (args[0]._id === creation.creatorMembershipOperationId) throw new Error("Creator intent unavailable");
      return insert(...args);
    });
    expect(await service.execute(creation)).toMatchObject({ operationId: creation._id, state: "pending" });
    expect(await service.isComplete(creation._id)).toBe(false);
    expect(await read("project_memberships", `${creation.targetId}:${creation.actor}`)).toBeNull();
    failure.mockRestore();
    expect(await service.reconcile(creation._id)).toMatchObject({ state: "completed" });
    expect(await read("project_memberships", `${creation.targetId}:${creation.actor}`)).toMatchObject({ role: "admin", revision: 1 });
  });

  it("recovers a creator grant with lost acknowledgement without granting early access", async () => {
    const creation = projectCreation();
    const { target } = intercept();
    const insert = target.insertOne.bind(target);
    vi.spyOn(target, "insertOne").mockImplementationOnce(async (...args) => {
      await insert(...args);
      throw new Error("Creator grant acknowledgement lost");
    });
    expect(await service.execute(creation)).toMatchObject({ operationId: creation._id, state: "pending" });
    expect((await new Authorization(db).memberships(creation.actor)).some(m => m.projectId === creation.targetId)).toBe(false);
    expect(await service.reconcile(creation._id)).toMatchObject({ state: "completed" });
    expect(await read("project_memberships", `${creation.targetId}:${creation.actor}`)).toMatchObject({
      role: "admin", revision: 1, appliedOperationIds: [creation.creatorMembershipOperationId],
    });
  });

  it("withholds creator access until parent completion and preserves a later revocation during recovery", async () => {
    const creation = projectCreation();
    const { operations } = intercept();
    const update = operations.updateOne.bind(operations);
    const failure = vi.spyOn(operations, "updateOne").mockImplementation(async (...args) => {
      if (args[0]._id === creation._id) throw new Error("Project completion unavailable");
      return update(...args);
    });
    expect(await service.execute(creation)).toMatchObject({ operationId: creation._id, state: "pending" });
    expect(await service.isComplete(creation.creatorMembershipOperationId)).toBe(true);
    expect((await new Authorization(db).memberships(creation.actor)).some(m => m.projectId === creation.targetId)).toBe(false);
    await service.execute(intent({
      targetId: `${creation.targetId}:${creation.actor}`, initial: undefined, expectedRevision: 1,
      change: { revokedAt: "$operationTime" },
    }));
    failure.mockRestore();
    expect(await service.reconcile(creation._id)).toMatchObject({ state: "completed" });
    expect(await service.execute(creation)).toMatchObject({ state: "completed" });
    expect(await read("project_memberships", `${creation.targetId}:${creation.actor}`)).toMatchObject({
      revokedAt: expect.any(Date), revision: 2,
    });
    expect((await new Authorization(db).memberships(creation.actor)).some(m => m.projectId === creation.targetId)).toBe(false);
  });

  it("coalesces concurrent identical project creation and creator membership into one grant", async () => {
    const creation = projectCreation();
    const results = await Promise.all([service.execute(creation), service.execute(creation)]);
    expect(results.every(result => result.state === "completed")).toBe(true);
    expect(await db.collection("project_memberships").countDocuments({ projectId: creation.targetId })).toBe(1);
    expect(await read("project_memberships", `${creation.targetId}:${creation.actor}`)).toMatchObject({
      role: "admin", revision: 1, appliedOperationIds: [creation.creatorMembershipOperationId],
    });
  });

  it("persists nothing on the target when intent storage fails", async () => {
    const change = intent();
    vi.spyOn(intercept().operations, "insertOne").mockRejectedValueOnce(new Error("Intent store unavailable"));
    await expect(service.execute(change)).rejects.toMatchObject({ status: 503, code: "intent_unavailable" });
    expect(await read(change.collection, change.targetId)).toBeNull();
  });

  it("reuses identical input and rejects a conflicting idempotency payload", async () => {
    const change = intent();
    expect(await service.execute(change)).toMatchObject({ state: "completed", revision: 1 });
    expect(await service.execute(change)).toMatchObject({ state: "completed", revision: 1 });
    await expect(service.execute({ ...change, change: { role: "admin" } })).rejects.toMatchObject({ status: 409, code: "idempotency_conflict" });
    expect(await read(change.collection, change.targetId)).toMatchObject({ role: "reader", revision: 1 });
  });

  it("records a competing revision conflict without applying its role", async () => {
    const first = intent();
    await service.execute(first);
    const second = intent({ targetId: first.targetId, change: { role: "admin" } });
    await expect(service.execute(second)).rejects.toMatchObject({ status: 409, code: "revision_conflict" });
    expect(await read("admin_operations", second._id)).toMatchObject({ state: "conflict" });
    expect(await read(first.collection, first.targetId)).toMatchObject({ role: "reader", revision: 1 });
  });

  it("does not create an absent target using a nonzero revision", async () => {
    const change = intent({ expectedRevision: 4 });
    await expect(service.execute(change)).rejects.toMatchObject({ status: 409 });
    expect(await read(change.collection, change.targetId)).toBeNull();
  });

  it("recovers an interruption after intent but before target mutation", async () => {
    const change = intent();
    vi.spyOn(intercept().target, "insertOne").mockRejectedValueOnce(new Error("Crash before insert"));
    expect(await service.execute(change)).toMatchObject({ state: "pending" });
    expect(await read(change.collection, change.targetId)).toBeNull();
    expect(await service.reconcile(change._id)).toMatchObject({ state: "completed", revision: 1 });
    expect(await read(change.collection, change.targetId)).toMatchObject({ role: "reader", revision: 1 });
  });

  it("recovers an applied write with a lost acknowledgement exactly once", async () => {
    const change = intent();
    const { target } = intercept();
    const insert = target.insertOne.bind(target);
    vi.spyOn(target, "insertOne").mockImplementationOnce(async (...args) => {
      await insert(...args);
      throw new Error("Connection lost after server applied insert");
    });
    expect(await service.execute(change)).toMatchObject({ state: "pending" });
    expect(await service.isComplete(change._id)).toBe(false);
    expect(await service.reconcile(change._id)).toMatchObject({ state: "completed", revision: 1 });
    expect(await read(change.collection, change.targetId)).toMatchObject({ revision: 1, appliedOperationIds: [change._id] });
  });

  it("withholds completion on failed audit completion and reconciles after a newer operation", async () => {
    const first = intent();
    vi.spyOn(intercept().operations, "updateOne").mockRejectedValueOnce(new Error("Completion store unavailable"));
    expect(await service.execute(first)).toMatchObject({ state: "pending" });
    expect(await service.isComplete(first._id)).toBe(false);
    const second = intent({ targetId: first.targetId, expectedRevision: 1, change: { role: "contributor" } });
    expect(await service.execute(second)).toMatchObject({ state: "completed", revision: 2 });
    expect(await service.reconcile(first._id)).toMatchObject({ state: "completed", revision: 1 });
    expect(await read(first.collection, first.targetId)).toMatchObject({
      role: "contributor", revision: 2, lastOperationId: second._id,
      appliedOperationIds: [first._id, second._id],
    });
  });

  it("reports pending when completion matches no durable intent", async () => {
    const change = intent();
    vi.spyOn(intercept().operations, "updateOne").mockResolvedValueOnce({
      acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedCount: 0, upsertedId: null,
    });
    expect(await service.execute(change)).toMatchObject({ state: "pending" });
    expect(await service.isComplete(change._id)).toBe(false);
    expect(await read(change.collection, change.targetId)).toMatchObject({ revision: 1 });
    expect(await service.reconcile(change._id)).toMatchObject({ state: "completed", revision: 1 });
  });

  it("requires an acknowledged completion write before reporting success", async () => {
    const change = intent();
    vi.spyOn(intercept().operations, "updateOne").mockResolvedValueOnce({
      acknowledged: false, matchedCount: 0, modifiedCount: 0, upsertedCount: 0, upsertedId: null,
    });
    expect(await service.execute(change)).toMatchObject({ state: "pending" });
    expect(await service.isComplete(change._id)).toBe(false);
    expect(await service.reconcile(change._id)).toMatchObject({ state: "completed", revision: 1 });
  });

  it("coalesces competing identical operations without confusing a completed marker for a missing write", async () => {
    const change = intent();
    const results = await Promise.all([service.execute(change), service.execute(change)]);
    expect(results).toEqual([
      { operationId: change._id, state: "completed", revision: 1 },
      { operationId: change._id, state: "completed", revision: 1 },
    ]);
    expect(await read(change.collection, change.targetId)).toMatchObject({
      revision: 1, appliedOperationIds: [change._id],
    });
  });

  it("revokes/regrants a single membership using retained revisions and no duplicate row", async () => {
    const grant = intent();
    await service.execute(grant);
    const revoke = intent({ targetId: grant.targetId, expectedRevision: 1, initial: undefined, change: { revokedAt: "$operationTime" } });
    await service.execute(revoke);
    expect(await read(grant.collection, grant.targetId)).toMatchObject({ revokedAt: expect.any(Date), revision: 2 });
    await service.execute(intent({ targetId: grant.targetId, expectedRevision: 2, change: { role: "admin" }, unset: ["revokedAt"] }));
    const membership = await read(grant.collection, grant.targetId);
    expect(membership).toMatchObject({ role: "admin", revision: 3 });
    expect(membership).not.toHaveProperty("revokedAt");
    expect(await db.collection(grant.collection).countDocuments({ userId: grant.initial?.userId })).toBe(1);
  });

  it("rechecks role in the final ordinary-user disable CAS after operator promotion", async () => {
    const id = randomUUID();
    await db.collection<Document & { _id: string }>("users").insertOne({ _id: id, role: "admin", revision: 1 });
    const disable = intent({ collection: "users", targetId: id, initial: undefined, expectedRevision: 0,
      change: { disabledAt: "$operationTime" }, condition: { role: "user" } });
    await expect(service.execute(disable)).rejects.toMatchObject({ status: 409 });
    expect(await read("users", id)).not.toHaveProperty("disabledAt");
  });

  it("coalesces concurrent exact-identity bootstrap into one durable promotion", async () => {
    const bootstrapDb = client.db(`rbac_bootstrap_${randomUUID().replaceAll("-", "")}`);
    try {
      const users = bootstrapDb.collection<UserDocument>("users");
      await users.createIndex({ idp: 1, idpTenant: 1, idpSubject: 1 }, { unique: true, name: "uniq_identity" });
      const identity = { idp: "entra", idpTenant: "fixture-tenant", idpSubject: randomUUID() };
      const store = new UserStore(users, {
        bootstrapAdmins: new Set([`${identity.idp}:${identity.idpTenant}/${identity.idpSubject}`]),
        bootstrapTenants: new Set([identity.idpTenant]),
        operations: new AdminOperations(bootstrapDb),
      });
      const [first, second] = await Promise.all([
        store.upsertOnLogin(identity, {}), store.upsertOnLogin(identity, {}),
      ]);
      expect(first._id).toBe(second._id);
      expect(first.role).toBe("admin");
      expect(second.role).toBe("admin");
      expect(await users.countDocuments()).toBe(1);
      expect(await bootstrapDb.collection("admin_operations").countDocuments({ state: "completed" })).toBe(1);
      expect(await bootstrapDb.collection("project_memberships").countDocuments()).toBe(0);
    } finally { await bootstrapDb.dropDatabase(); }
  });

  it("does not let bootstrap overwrite a concurrent targeted operator disable", async () => {
    const users = db.collection<UserDocument>("users");
    const identity = { idp: "entra", idpTenant: "fixture-tenant", idpSubject: randomUUID() };
    const operations = new AdminOperations(db);
    const execute = operations.execute.bind(operations);
    const store = new UserStore(users, {
      bootstrapAdmins: new Set([`${identity.idp}:${identity.idpTenant}/${identity.idpSubject}`]),
      bootstrapTenants: new Set([identity.idpTenant]), operations,
    });
    vi.spyOn(operations, "execute").mockImplementationOnce(async change => {
      await operatorAccess(db, {
        database, confirmDatabase: database, ...{ idp: "entra", tenant: identity.idpTenant, subject: identity.idpSubject },
        userId: change.targetId, revision: 0, role: "user", disabled: "true",
        operator: "fixture-operator", reason: "Concurrent exact-identity disable", operationId: randomUUID(), bootstrapReviewed: true,
      });
      return execute(change);
    });
    await expect(store.upsertOnLogin(identity, {})).rejects.toMatchObject({ code: "revision_conflict" });
    const disabled = await users.findOne(identity);
    expect(disabled).toMatchObject({ role: "user", disabledAt: expect.any(Date), revision: 1 });
    expect(await store.upsertOnLogin(identity, {})).toMatchObject({ role: "user", disabledAt: expect.any(Date) });
  });

  it("requires the exact operator identity/UUID/database and preserves membership on recovery", async () => {
    const userId = randomUUID(), projectId = randomUUID();
    const subject = randomUUID();
    await db.collection<Document & { _id: string }>("users").insertOne({
      _id: userId, role: "user", idp: "entra", idpTenant: "fixture-tenant", idpSubject: subject,
    });
    const input = OperatorAccessInput.parse({
      database, confirmDatabase: database, idp: "entra", tenant: "fixture-tenant", subject,
      userId, revision: 0, role: "admin", disabled: "false",
      operator: "fixture-operator", reason: "Targeted fixture recovery", operationId: randomUUID(), bootstrapReviewed: true,
    });
    await expect(operatorAccess(db, { ...input, subject: "different" })).rejects.toMatchObject({ code: "identity_mismatch" });
    await expect(operatorAccess(db, { ...input, confirmDatabase: "wrong" })).rejects.toMatchObject({ code: "database_mismatch" });
    const membership = intent({ targetId: `${projectId}:${userId}`, initial: { userId, projectId, createdByUserId: "fixture" } });
    await service.execute(membership);
    expect(await operatorAccess(db, input)).toMatchObject({ state: "completed" });
    expect(await operatorAccess(db, input)).toMatchObject({ state: "completed" });
    expect(await read("users", userId)).toMatchObject({ _id: userId, role: "admin", revision: 1, idpSubject: subject });
    expect(await read("admin_operations", input.operationId)).toMatchObject({ backup: { role: "user" }, state: "completed" });
    expect(await read("project_memberships", membership.targetId)).toMatchObject({ role: "reader", revision: 1 });
  });

  it("dry-runs and reruns only explicitly reviewed legacy mappings without implicit defaults", async () => {
    const projectId = randomUUID(), unmappedProject = randomUUID(), userId = randomUUID();
    await db.collection<Document & { _id: string }>("projects").insertMany([{ _id: projectId }, { _id: unmappedProject }]);
    await db.collection<Document & { _id: string }>("users").insertOne({ _id: userId, role: "user" });
    const manifest = LegacyMembershipManifest.parse({
      database, reviewedBy: "fixture-reviewer", reviewedAt: new Date().toISOString(), reason: "Synthetic explicit mapping",
      entries: [{ projectId, userId, role: "reader", revision: 0, operationId: randomUUID() }],
    });
    expect(await mapLegacyMemberships(db, manifest, false)).toEqual({ dryRun: true, entries: 1 });
    expect(await read("project_memberships", `${projectId}:${userId}`)).toBeNull();
    await mapLegacyMemberships(db, manifest, true);
    await mapLegacyMemberships(db, manifest, true);
    expect(await db.collection("project_memberships").countDocuments({ projectId, userId })).toBe(1);
    expect(await db.collection("project_memberships").countDocuments({ projectId: unmappedProject })).toBe(0);
    expect(LegacyMembershipManifest.safeParse({ ...manifest, entries: [...manifest.entries, ...manifest.entries] }).success).toBe(false);
  });

  it("validates all legacy mapping parents before granting the first entry", async () => {
    const projectId = randomUUID(), userId = randomUUID();
    await db.collection<Document & { _id: string }>("projects").insertOne({ _id: projectId });
    await db.collection<Document & { _id: string }>("users").insertOne({ _id: userId, role: "user" });
    const manifest = LegacyMembershipManifest.parse({
      database, reviewedBy: "fixture-reviewer", reviewedAt: new Date().toISOString(), reason: "Synthetic rejected mapping",
      entries: [
        { projectId, userId, role: "reader", revision: 0, operationId: randomUUID() },
        { projectId: randomUUID(), userId, role: "admin", revision: 0, operationId: randomUUID() },
      ],
    });
    await expect(mapLegacyMemberships(db, manifest, true)).rejects.toMatchObject({ status: 404 });
    expect(await read("project_memberships", `${projectId}:${userId}`)).toBeNull();
  });
});
