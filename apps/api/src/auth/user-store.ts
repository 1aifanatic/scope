// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { randomUUID } from "node:crypto";
import { MongoServerError, type Collection, type UpdateFilter } from "mongodb";
import {
  bootstrapAdminKey,
  type UserDocument,
  type UserProfile,
  type VerifiedIdentity,
} from "shared";
import type { AdminOperations } from "./admin-operations.js";

export interface UserStoreOptions {
  /** Identity keys (`${idp}:${tenant}/${subject}`) to promote to admin. */
  bootstrapAdmins?: Set<string>;
  /** Tenant allowlist gating bootstrap promotion (empty = no promotion). */
  bootstrapTenants?: Set<string>;
  operations?: Pick<AdminOperations, "execute">;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIdentityUpsertCollision(error: unknown, identity: VerifiedIdentity): boolean {
  if (!(error instanceof MongoServerError) || error.code !== 11000) return false;
  const pattern: unknown = error.keyPattern;
  const value: unknown = error.keyValue;
  if (isRecord(value) && (
    value.idp !== identity.idp ||
    value.idpTenant !== identity.idpTenant ||
    value.idpSubject !== identity.idpSubject
  )) return false;

  if (isRecord(pattern)) {
    return Object.keys(pattern).length === 3 &&
      pattern.idp === 1 && pattern.idpTenant === 1 && pattern.idpSubject === 1;
  }
  // CosmosDB may omit keyPattern/keyValue but still identify the known index.
  return /\bindex:\s+uniq_identity\s+dup key:/.test(error.message);
}

/**
 * Persistence for the `users` collection.
 *
 * On each explicit login upsert the identity triple is persisted (Just-In-Time
 * provisioning): a new user is minted a Scope User ID (UUID) with the default
 * role `"user"`, and an existing user has its profile (`email`, `displayName`,
 * `emailVerified`) and `lastLoginAt` refreshed. Email is persisted only when
 * explicitly verified. Admin bootstrap is **promote-only** and requires an
 * exact identity match and membership in the configured tenant allowlist.
 */
export class UserStore {
  private readonly bootstrapAdmins: Set<string>;
  private readonly bootstrapTenants: Set<string>;

  constructor(
    private readonly collection: Collection<UserDocument>,
    private readonly options: UserStoreOptions = {},
  ) {
    this.bootstrapAdmins = options.bootstrapAdmins ?? new Set();
    this.bootstrapTenants = options.bootstrapTenants ?? new Set();
  }

  /** JIT-upsert the user for a verified identity and return the stored record. */
  async upsertOnLogin(
    identity: VerifiedIdentity,
    profile: UserProfile,
  ): Promise<UserDocument> {
    const now = new Date();

    const set: Record<string, unknown> = {
      updatedAt: now,
      lastLoginAt: now,
    };
    // Only refresh fields the profile actually provided, so a token missing a
    // claim never clobbers a previously-known value.
    if (profile.displayName !== undefined) set.displayName = profile.displayName;
    if (profile.alias !== undefined || profile.email !== undefined) set.alias = profile.alias ?? profile.email;
    if (profile.emailVerified === true) {
      if (profile.email !== undefined) set.email = profile.email;
      set.emailVerified = true;
    } else if (profile.emailVerified === false) {
      set.emailVerified = profile.emailVerified;
    }

    const setOnInsert: Record<string, unknown> = {
      _id: randomUUID(),
      idp: identity.idp,
      idpTenant: identity.idpTenant,
      idpSubject: identity.idpSubject,
      role: "user",
      createdAt: now,
    };

    const update = { $set: set, $setOnInsert: setOnInsert } as unknown as
      UpdateFilter<UserDocument>;

    const filter = {
      idp: identity.idp,
      idpTenant: identity.idpTenant,
      idpSubject: identity.idpSubject,
    };
    let result: UserDocument | null;
    try {
      result = await this.collection.findOneAndUpdate(
        filter,
        update,
        { upsert: true, returnDocument: "after" },
      );
    } catch (error) {
      if (!isIdentityUpsertCollision(error, identity)) throw error;
      // Another login inserted this exact identity. Refresh it without retrying
      // the insert or replacing the winner's app-owned ID and role.
      result = await this.collection.findOneAndUpdate(
        filter,
        { $set: set } as UpdateFilter<UserDocument>,
        { upsert: false, returnDocument: "after" },
      );
      if (!result) throw error;
    }

    if (!result) {
      throw new Error("Failed to upsert user during login");
    }
    const user = result as UserDocument;

    if (this.shouldBootstrapAdmin(identity) && user.role !== "admin" && !user.disabledAt) {
      if (!this.options.operations) {
        throw new Error("Bootstrap promotion requires durable administrative operations");
      }
      const securityUser = user as UserDocument & { revision?: number };
      const result = await this.options.operations.execute({
        _id: `bootstrap:${user._id}:${securityUser.revision ?? 0}`,
        actor: `bootstrap:${bootstrapAdminKey(identity.idp, identity.idpTenant, identity.idpSubject)}`,
        reason: "Verified configured bootstrap identity",
        collection: "users", targetId: user._id, expectedRevision: securityUser.revision ?? 0,
        change: { role: "admin" }, unset: [], condition: { role: "user", disabledAt: { $exists: false } },
      });
      if (result.state === "pending") throw new Error(`Bootstrap operation pending: ${result.operationId}`);
      const promoted = await this.findById(user._id);
      if (!promoted) throw new Error("Bootstrap user disappeared");
      return promoted;
    }

    return user;
  }

  /** Read an existing identity without provisioning or refreshing login/profile fields. */
  async findByIdentity(identity: VerifiedIdentity): Promise<UserDocument | null> {
    return this.collection.findOne({
      idp: identity.idp,
      idpTenant: identity.idpTenant,
      idpSubject: identity.idpSubject,
    });
  }

  /** Look up a user by Scope User ID. */
  async findById(id: string): Promise<UserDocument | null> {
    const doc = await this.collection.findOne({
      _id: id,
    } as unknown as Parameters<Collection<UserDocument>["findOne"]>[0]);
    return (doc as UserDocument | null) ?? null;
  }

  private shouldBootstrapAdmin(identity: VerifiedIdentity): boolean {
    const key = bootstrapAdminKey(
      identity.idp,
      identity.idpTenant,
      identity.idpSubject,
    );
    if (!this.bootstrapAdmins.has(key)) return false;
    return this.bootstrapTenants.has(identity.idpTenant);
  }
}
