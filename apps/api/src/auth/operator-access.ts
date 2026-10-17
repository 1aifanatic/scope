// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { MongoClient, type Db, type Document } from "mongodb";
import { z } from "zod";
import { AdminOperations, AccessError, type AdminOperation } from "./admin-operations.js";

export const OperatorAccessInput = z.object({
  database: z.string().min(1), confirmDatabase: z.string().min(1),
  idp: z.literal("entra"), tenant: z.string().min(1), subject: z.string().min(1),
  userId: z.string().uuid(), revision: z.coerce.number().int().nonnegative(),
  role: z.enum(["admin", "user"]), disabled: z.enum(["true", "false"]),
  operator: z.string().min(1), reason: z.string().min(1), operationId: z.string().min(1),
  bootstrapReviewed: z.literal(true),
}).strict();

export async function operatorAccess(db: Db, input: z.infer<typeof OperatorAccessInput>) {
  if (db.databaseName !== input.database || input.database !== input.confirmDatabase) {
    throw new AccessError(400, "database_mismatch", "Explicit database confirmation does not match");
  }
  const user = await db.collection<Document & { _id: string }>("users").findOne({
    _id: input.userId, idp: input.idp, idpTenant: input.tenant, idpSubject: input.subject,
  }, { timeoutMS: 5_000 });
  if (!user) throw new AccessError(404, "identity_mismatch", "Exact existing identity and Scope UUID not found");
  const prior = await db.collection<AdminOperation>("admin_operations").findOne({ _id: input.operationId }, { timeoutMS: 5_000 });
  const operations = new AdminOperations(db);
  return operations.execute({
    _id: input.operationId, actor: `operator:${input.operator}`, reason: input.reason,
    collection: "users", targetId: user._id, expectedRevision: input.revision,
    condition: { idp: input.idp, idpTenant: input.tenant, idpSubject: input.subject },
    change: { role: input.role, ...(input.disabled === "true" ? { disabledAt: "$operationTime" } : {}) },
    unset: input.disabled === "false" ? ["disabledAt"] : [],
    backup: prior?.backup ?? user,
  });
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: {
    database: { type: "string" }, "confirm-database": { type: "string" }, idp: { type: "string" },
    tenant: { type: "string" }, subject: { type: "string" }, "user-id": { type: "string" },
    revision: { type: "string" }, role: { type: "string" }, disabled: { type: "string" },
    operator: { type: "string" }, reason: { type: "string" }, "operation-id": { type: "string" },
    "bootstrap-reviewed": { type: "boolean" },
  } });
  const input = OperatorAccessInput.parse({
    database: values.database, confirmDatabase: values["confirm-database"], idp: values.idp,
    tenant: values.tenant, subject: values.subject, userId: values["user-id"], revision: values.revision,
    role: values.role, disabled: values.disabled, operator: values.operator, reason: values.reason,
    operationId: values["operation-id"], bootstrapReviewed: values["bootstrap-reviewed"],
  });
  const uri = process.env.AUTH_OPERATOR_MONGO_URI;
  if (!uri) throw new Error("AUTH_OPERATOR_MONGO_URI is required; use authenticated operator credentials outside local emulation");
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5_000 });
  try {
    await client.connect();
    const result = await operatorAccess(client.db(input.database), input);
    console.log(JSON.stringify(result));
    if (result.state !== "completed") process.exitCode = 2;
  } finally { await client.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
}
