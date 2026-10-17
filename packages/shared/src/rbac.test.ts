// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

import { describe, expect, it } from "vitest";
import { ProjectRoleSchema, projectPermissions, REPORT_GENERATION_ENABLED, resolveAuthEnabledFlag } from "./rbac.js";

describe("Shared authentication and RBAC switch", () => {
  it.each([undefined, "", "typo", "f alse", "o ff", "true", "1", "yes", "on", " TRUE "])("keeps security enabled for %j", value => {
    expect(resolveAuthEnabledFlag(value)).toBe(true);
  });
  it.each(["false", "0", "no", "off", " OFF "])("accepts explicit opt-out %j", value => {
    expect(resolveAuthEnabledFlag(value)).toBe(false);
  });
});

describe("Fixed project role bundles", () => {
  it.each([
    ["reader", ["content:read"]],
    ["contributor", ["content:read", "content:write", "content:delete"]],
    ["admin", ["content:read", "content:write", "content:delete", "settings:write"]],
  ] as const)("%s has no lifecycle, membership, wildcard or creator-specific permissions", (role, expected) => {
    expect(projectPermissions(role)).toEqual(expected);
  });
  it("rejects unapproved/custom roles and disables new report generation", () => {
    for (const role of ["owner", "platform-admin", "*", "custom"]) expect(ProjectRoleSchema.safeParse(role).success).toBe(false);
    expect(REPORT_GENERATION_ENABLED).toBe(false);
  });
});
