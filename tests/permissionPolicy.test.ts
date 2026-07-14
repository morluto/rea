import { describe, expect, it } from "vitest";
import { win32 } from "node:path";

import {
  consumePermission,
  clearSessionPermissions,
  createPermissionPolicy,
  evaluatePermission,
  grantPermission,
  isPathContained,
  reloadPermissionCeilings,
  revokePermission,
} from "../src/domain/permissionPolicy.js";

describe("permission policy", () => {
  it("rejects sibling escapes for both POSIX and Windows path separators", () => {
    expect(isPathContained("/allowed", "/secret")).toBe(false);
    expect(
      isPathContained("C:\\allowed", "C:\\secret", {
        relative: win32.relative,
        isAbsolute: win32.isAbsolute,
        sep: win32.sep,
      }),
    ).toBe(false);
    expect(
      isPathContained("C:\\allowed", "C:\\allowed\\nested", {
        relative: win32.relative,
        isAbsolute: win32.isAbsolute,
        sep: win32.sep,
      }),
    ).toBe(true);
  });

  it("never lets a session grant exceed the administrator ceiling", () => {
    const policy = createPermissionPolicy([
      {
        capability: "process_capture",
        roots: ["/workspace/project"],
        executables: ["/workspace/project/bin/tool"],
        environment_names: ["LANG"],
        network: "loopback",
        mount: false,
      },
    ]);
    const granted = grantPermission(policy, {
      grant_id: "grant_session_1",
      capability: "process_capture",
      roots: ["/workspace/project"],
      executables: ["/workspace/project/bin/tool"],
      environment_names: ["LANG"],
      network: "loopback",
      mount: false,
      lifetime: "session",
      operation_identity: null,
      expires_at: null,
    });

    expect(granted.ok).toBe(true);
    if (!granted.ok) return;
    expect(
      evaluatePermission(granted.value, {
        capability: "process_capture",
        roots: ["/workspace/project/data"],
        executables: ["/workspace/project/bin/tool"],
        environment_names: ["LANG"],
        network: "loopback",
        mount: false,
        operation_identity: "capture-1",
      }),
    ).toMatchObject({ allowed: true });
    expect(
      evaluatePermission(granted.value, {
        capability: "process_capture",
        roots: ["/workspace/project/data"],
        executables: ["/workspace/project/bin/tool"],
        environment_names: ["LANG", "TOKEN"],
        network: "external",
        mount: false,
        operation_identity: "capture-2",
      }),
    ).toMatchObject({
      allowed: false,
      reason: "outside_administrator_ceiling",
      missing: {
        environment_names: ["TOKEN"],
        network: "external",
      },
    });
  });

  it("authorizes browser observation only for exact declared origins", () => {
    const scope = {
      capability: "browser_observe" as const,
      roots: [],
      executables: [],
      environment_names: [],
      origins: ["http://127.0.0.1:9222", "https://app.example.test"],
      network: "external" as const,
      mount: false,
    };
    const granted = grantPermission(createPermissionPolicy([scope]), {
      ...scope,
      grant_id: "browser-session",
      lifetime: "session",
      operation_identity: null,
      expires_at: null,
    });
    expect(granted.ok).toBe(true);
    if (!granted.ok) return;

    expect(
      evaluatePermission(granted.value, {
        ...scope,
        operation_identity: "inspect:page-1",
      }),
    ).toMatchObject({ allowed: true });
    expect(
      evaluatePermission(granted.value, {
        ...scope,
        origins: ["http://127.0.0.1:9222", "https://cdn.example.test"],
        operation_identity: "inspect:page-2",
      }),
    ).toMatchObject({
      allowed: false,
      reason: "outside_administrator_ceiling",
      missing: { origins: ["https://cdn.example.test"] },
    });
  });

  it("consumes once grants and applies revocation and ceiling reload immediately", () => {
    const ceiling = {
      capability: "evidence_write" as const,
      roots: ["/workspace/evidence"],
      executables: [],
      environment_names: [],
      network: "none" as const,
      mount: false,
    };
    const granted = grantPermission(createPermissionPolicy([ceiling]), {
      ...ceiling,
      grant_id: "grant_once_1",
      lifetime: "once",
      operation_identity: "write:report.json",
      expires_at: null,
    });
    expect(granted.ok).toBe(true);
    if (!granted.ok) return;
    const request = {
      ...ceiling,
      roots: ["/workspace/evidence/report.json"],
      operation_identity: "write:report.json",
    };
    const decision = evaluatePermission(granted.value, request);
    expect(decision).toMatchObject({ allowed: true });
    if (!decision.allowed) return;

    const consumed = consumePermission(granted.value, decision);
    expect(evaluatePermission(consumed, request)).toMatchObject({
      allowed: false,
      reason: "grant_revoked_or_consumed",
    });
    expect(
      evaluatePermission(
        revokePermission(granted.value, "grant_once_1"),
        request,
      ),
    ).toMatchObject({
      allowed: false,
      reason: "grant_revoked_or_consumed",
    });
    expect(
      evaluatePermission(reloadPermissionCeilings(granted.value, []), request),
    ).toMatchObject({
      allowed: false,
      reason: "outside_administrator_ceiling",
    });
  });

  it("reports a missing scope when revoked grants cover a different root", () => {
    const ceiling = {
      capability: "evidence_write" as const,
      roots: ["/workspace"],
      executables: [],
      environment_names: [],
      network: "none" as const,
      mount: false,
    };
    const granted = grantPermission(createPermissionPolicy([ceiling]), {
      ...ceiling,
      roots: ["/workspace/first"],
      grant_id: "revoked-other-root",
      lifetime: "project",
      operation_identity: null,
      expires_at: null,
    });
    expect(granted.ok).toBe(true);
    if (!granted.ok) return;

    expect(
      evaluatePermission(
        revokePermission(granted.value, "revoked-other-root"),
        {
          ...ceiling,
          roots: ["/workspace/second"],
          operation_identity: "write:report.json",
        },
      ),
    ).toMatchObject({
      allowed: false,
      reason: "grant_required",
      missing: { roots: ["/workspace/second"] },
    });
  });

  it("expires grants, removes session authority on disconnect, and never combines partial grants", () => {
    const ceiling = {
      capability: "process_capture" as const,
      roots: ["/workspace"],
      executables: ["/bin/tool"],
      environment_names: ["LANG"],
      network: "loopback" as const,
      mount: false,
    };
    const base = createPermissionPolicy([ceiling]);
    const rootOnly = grantPermission(base, {
      ...ceiling,
      executables: [],
      environment_names: [],
      network: "none",
      grant_id: "root-only",
      lifetime: "project",
      operation_identity: null,
      expires_at: null,
    });
    expect(rootOnly.ok).toBe(true);
    if (!rootOnly.ok) return;
    const executableOnly = grantPermission(rootOnly.value, {
      ...ceiling,
      roots: [],
      grant_id: "exec-only",
      lifetime: "session",
      operation_identity: null,
      expires_at: "2026-07-14T00:00:00.000Z",
    });
    expect(executableOnly.ok).toBe(true);
    if (!executableOnly.ok) return;
    const request = {
      ...ceiling,
      operation_identity: "capture",
    };

    expect(
      evaluatePermission(
        executableOnly.value,
        request,
        new Date("2026-07-13T00:00:00.000Z"),
      ),
    ).toMatchObject({ allowed: false, reason: "grant_required" });
    const expiring = grantPermission(base, {
      ...ceiling,
      grant_id: "expiring",
      lifetime: "session",
      operation_identity: null,
      expires_at: "2026-07-14T00:00:00.000Z",
    });
    expect(expiring.ok).toBe(true);
    if (!expiring.ok) return;
    expect(
      evaluatePermission(
        expiring.value,
        request,
        new Date("2026-07-15T00:00:00.000Z"),
      ),
    ).toMatchObject({ allowed: false, reason: "grant_expired" });
    expect(
      clearSessionPermissions(executableOnly.value).grants.map(
        ({ grant_id }) => grant_id,
      ),
    ).toEqual(["root-only"]);
  });
});
