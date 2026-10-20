// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { performance } from "node:perf_hooks";
import express from "express";
import request from "supertest";
import { MongoClient } from "mongodb";
import { UserDocumentSchema } from "shared";
import { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
import { afterEach, describe, expect, it, vi } from "vitest";
import { apiRoute } from "../openapi/api-route.js";
import { Authorization, protectStream, routePolicy } from "./authorization.js";
import { AccessError } from "./admin-operations.js";

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("Explicit HTTP route classification", () => {
  it("fails registration for unclassified endpoints", () => {
    expect(() => routePolicy("get", "/api/v1/unclassified")).toThrow("Unclassified API route");
  });
  it("keeps enrollment, control plane, metadata and project data distinct", () => {
    expect(routePolicy("post", "/api/v1/users/me")).toBe("self");
    expect(routePolicy("get", "/api/v1/admin/users")).toBe("platform");
    expect(routePolicy("get", "/api/v1/admin/users/search")).toBe("platform");
    expect(routePolicy("get", "/api/v1/admin/platform-admins")).toBe("platform");
    expect(routePolicy("post", "/api/v1/admin/users/:id/promote")).toBe("platform");
    expect(routePolicy("get", "/api/v1/agents")).toBe("metadata");
    expect(routePolicy("post", "/api/v1/agents")).toBe("platform");
    expect(routePolicy("get", "/api/v1/projects")).toBe("projects");
    expect(routePolicy("get", "/api/v1/resources/revisions/:id")).toBe("project");
  });
  it.each(["/reports", "/reports/bulk-create", "/reports/trigger", "/reports/bulk-trigger", "/reports/:id/insights"])(
    "blocks %s before any handler or enqueue operation", async path => {
      const app = express();
      const enqueue = vi.fn();
      apiRoute(app, new OpenAPIRegistry(), {
        method: "post", path: `/api/v1${path}`, tags: ["Reports"], summary: "Cutover fixture",
        response: z.unknown(), handler: (_req, res) => { enqueue(); res.json({}); },
      });
      app.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
        res.status(error instanceof AccessError ? error.status : 500).json({ error: error.message });
      });
      expect((await request(app).post(`/api/v1${path.replace(":id", "fixture")}`).send({})).status).toBe(503);
      expect(enqueue).not.toHaveBeenCalled();
    });
  it("keeps stored-report reads and read-only bulk status available for project authorization", () => {
    expect(routePolicy("get", "/api/v1/reports/:id")).toBe("project");
    expect(routePolicy("post", "/api/v1/reports/bulk-status")).toBe("project");
    expect(routePolicy("post", "/api/v1/reports/bulk-summary")).toBe("project");
  });
  it("fails closed before controller execution when authorization has not initialized", async () => {
    const app = express();
    const controller = vi.fn();
    apiRoute(app, new OpenAPIRegistry(), {
      method: "get", path: "/api/v1/criteria", tags: ["Criteria"], summary: "Unavailable authority",
      response: z.unknown(), handler: (_req, res) => { controller(); res.json([]); },
    });
    app.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(error instanceof AccessError ? error.status : 500).json({ error: error.message });
    });
    expect((await request(app).get("/api/v1/criteria")).status).toBe(503);
    expect(controller).not.toHaveBeenCalled();
  });
});

describe("Canonical authority work budget", () => {
  it("passes one original deadline through identity and membership reads", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const authority = new Authorization(new MongoClient("mongodb://127.0.0.1:1").db("unused_unit_fixture"));
    const user = UserDocumentSchema.parse({
      _id: "fixture-user", idp: "entra", idpTenant: "fixture", idpSubject: "fixture",
      createdAt: new Date(), updatedAt: new Date(),
    });
    vi.spyOn(authority, "currentUser").mockImplementation(async (_req, deadline) => {
      expect(deadline).toBe(20_000);
      now = 19_000;
      return user;
    });
    vi.spyOn(authority, "memberships").mockImplementation(async (_userId, deadline) => {
      expect(deadline).toBe(20_000);
      now = 20_001;
      return [];
    });
    await expect(authority.capabilities(express.request)).rejects.toMatchObject({ code: "authority_timeout" });
  });

  describe("Explicit authentication opt-out", () => {
    const authority = () => new Authorization(new MongoClient("mongodb://127.0.0.1:1").db("unused_unit_fixture"), false);

    it.each(["/api/v1/admin/users", "/api/v1/admin/platform-admins", "/api/v1/admin/users/:id/promote",
      "/api/v1/admin/operations/:id", "/api/v1/projects/:id/members", "/api/v1/projects/:id/members/:userId"])(
      "does not open identity or membership administration at %s", async path => {
        await expect(authority().guard(express.request, "get", path, routePolicy("get", path)))
          .rejects.toMatchObject({ code: "authentication_disabled" });
      },
    );
    it.each(["/api/v1/projects", "/api/v1/agents", "/api/v1/models", "/api/v1/feature-flags"])(
      "allows legacy application access at %s without reading users or memberships", async path => {
        const auth = authority();
        const current = vi.spyOn(auth, "currentUser");
        const memberships = vi.spyOn(auth, "memberships");
        await expect(auth.guard(express.request, "get", path, routePolicy("get", path))).resolves.toBeTypeOf("number");
        expect(current).not.toHaveBeenCalled();
        expect(memberships).not.toHaveBeenCalled();
      },
    );
    it("does not enable report producers when auth is disabled", async () => {
      await expect(authority().guard(express.request, "post", "/api/v1/reports", "disabled"))
        .rejects.toMatchObject({ code: "report_generation_disabled" });
    });
  });

  it("does not start a new membership query after its deadline expires", async () => {
    vi.spyOn(performance, "now").mockReturnValue(20_001);
    const authority = new Authorization(new MongoClient("mongodb://127.0.0.1:1").db("unused_unit_fixture"));
    await expect(authority.memberships("fixture-user", 20_000)).rejects.toMatchObject({ code: "authority_timeout" });
  });
});

describe("Open stream freshness leases", () => {
  it("closes at the original deadline during a hung authority read and refuses subsequent writes", async () => {
    vi.useFakeTimers();
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const originalWrite = vi.fn(() => true);
    const res: Parameters<typeof protectStream>[0] = { write: originalWrite, end: vi.fn(), once: vi.fn() };
    protectStream(res, () => new Promise<number>(() => {}), 20000);
    now = 19999;
    await vi.advanceTimersByTimeAsync(19000);
    expect(res.end).not.toHaveBeenCalled();
    now = 20000;
    await vi.advanceTimersByTimeAsync(1000);
    expect(res.end).toHaveBeenCalled();
    expect(res.write("not permitted")).toBe(false);
    expect(originalWrite).not.toHaveBeenCalled();
  });
  it("closes on the first denied authority recheck rather than retaining a warm grant", async () => {
    vi.useFakeTimers();
    vi.spyOn(performance, "now").mockReturnValue(0);
    const res: Parameters<typeof protectStream>[0] = { write: vi.fn(() => true), end: vi.fn(), once: vi.fn() };
    protectStream(res, async () => { throw new AccessError(404, "not_found", "Not found"); }, 20000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(res.end).toHaveBeenCalledOnce();
    expect(res.write("forbidden")).toBe(false);
  });
  it("never outlives the token-capped initial deadline", async () => {
    vi.useFakeTimers();
    vi.spyOn(performance, "now").mockReturnValue(2000);
    const res: Parameters<typeof protectStream>[0] = { write: vi.fn(() => true), end: vi.fn(), once: vi.fn() };
    protectStream(res, async () => 1000, 1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(res.end).toHaveBeenCalled();
  });
  it("cannot be revived by a successful authority result arriving after closure", async () => {
    vi.useFakeTimers();
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    let complete: ((deadline: number) => void) | undefined;
    const res: Parameters<typeof protectStream>[0] = { write: vi.fn(() => true), end: vi.fn(), once: vi.fn() };
    protectStream(res, () => new Promise<number>(resolve => { complete = resolve; }), 20_000);
    await vi.advanceTimersByTimeAsync(1000);
    now = 20_000;
    await vi.advanceTimersByTimeAsync(19_000);
    expect(res.end).toHaveBeenCalledOnce();
    if (!complete) throw new Error("Expected an in-flight authority recheck");
    complete(60_000);
    await Promise.resolve();
    expect(res.write("late result must not grant access")).toBe(false);
    expect(res.end).toHaveBeenCalledOnce();
  });
});
