import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import {
  canonicalizePermissionCeilings,
  canonicalizePermissionRequest,
  createPermissionAuthority,
  type PermissionAuthority,
} from "../src/application/PermissionAuthority.js";
import {
  createPermissionPolicy,
  evaluatePermission,
  type PermissionGrant,
  type PermissionScope,
} from "../src/domain/permissionPolicy.js";

describe("permission authority", () => {
  it("distinguishes an elicitable grant from administrator reconfiguration", async () => {
    const sandbox = await mkdtemp(
      join(tmpdir(), "rea-permission-remediation-"),
    );
    const allowedRoot = join(sandbox, "allowed");
    const outsideRoot = join(sandbox, "outside");
    await Promise.all([mkdir(allowedRoot), mkdir(outsideRoot)]);
    const authority = await createPermissionAuthority([
      evidenceScope(allowedRoot),
    ]);
    expect(authority.ok).toBe(true);
    if (!authority.ok) return;

    const inside = await authority.value.authorize(
      {
        ...evidenceScope(allowedRoot),
        operation_identity: "read:inside-ceiling",
      },
      "read",
      { elicitationSupported: true },
    );
    expect(inside).toMatchObject({
      ok: false,
      error: { elicitationSupported: true, restartRequired: false },
    });

    const outside = await authority.value.createConnectionAuthority().authorize(
      {
        ...evidenceScope(outsideRoot),
        operation_identity: "read:outside-ceiling",
      },
      "read",
      { elicitationSupported: true },
    );
    expect(outside).toMatchObject({
      ok: false,
      error: { elicitationSupported: false, restartRequired: true },
    });
  });

  it("accepts canonical aliases but rejects a symlink escape", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "rea-permission-"));
    const root = join(sandbox, "root");
    const outside = join(sandbox, "outside");
    await Promise.all([mkdir(root), mkdir(outside)]);
    await writeFile(join(root, "inside"), "inside");
    await writeFile(join(outside, "secret"), "secret");
    await symlink(root, join(sandbox, "root-alias"));
    await symlink(join(outside, "secret"), join(root, "escape"));
    const ceiling = await canonicalizePermissionCeilings([
      {
        capability: "evidence_read",
        roots: [join(sandbox, "root-alias")],
        executables: [],
        environment_names: [],
        network: "none",
        mount: false,
      },
    ]);
    expect(ceiling.ok).toBe(true);
    if (!ceiling.ok) return;
    const policy = createPermissionPolicy(ceiling.value, [
      {
        ...ceiling.value[0]!,
        grant_id: "administrator:evidence-read",
        lifetime: "administrator",
        operation_identity: null,
        expires_at: null,
      },
    ]);
    const inside = await canonicalizePermissionRequest(
      {
        capability: "evidence_read",
        roots: [join(root, "inside")],
        executables: [],
        environment_names: [],
        network: "none",
        mount: false,
        operation_identity: "read:inside",
      },
      "read",
    );
    const escaped = await canonicalizePermissionRequest(
      {
        capability: "evidence_read",
        roots: [join(root, "escape")],
        executables: [],
        environment_names: [],
        network: "none",
        mount: false,
        operation_identity: "read:escape",
      },
      "read",
    );
    expect(inside.ok).toBe(true);
    expect(escaped.ok).toBe(true);
    if (!inside.ok || !escaped.ok) return;
    expect(evaluatePermission(policy, inside.value)).toMatchObject({
      allowed: true,
    });
    expect(evaluatePermission(policy, escaped.value)).toMatchObject({
      allowed: false,
      reason: "outside_administrator_ceiling",
    });
  });

  it("canonicalizes a new write through its existing parent", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "rea-permission-write-"));
    const result = await canonicalizePermissionRequest(
      {
        capability: "evidence_write",
        roots: [join(sandbox, "new.json")],
        executables: [],
        environment_names: [],
        network: "none",
        mount: false,
        operation_identity: "write:new.json",
      },
      "write",
    );

    expect(result).toMatchObject({ ok: true });
    if (result.ok)
      expect(result.value.roots).toEqual([join(sandbox, "new.json")]);
  });

  it("commits a configured policy only after every grant validates", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "rea-permission-reload-"));
    const oldRoot = join(sandbox, "old");
    const newRoot = join(sandbox, "new");
    const outsideRoot = join(sandbox, "outside");
    await Promise.all([mkdir(oldRoot), mkdir(newRoot), mkdir(outsideRoot)]);
    const oldScope = evidenceScope(oldRoot);
    const newScope = evidenceScope(newRoot);
    const authority = await createPermissionAuthority(
      [oldScope],
      [administratorGrant(oldScope)],
    );
    expect(authority.ok).toBe(true);
    if (!authority.ok) return;

    const reloaded = await authority.value.replaceConfiguredPolicy({
      ceilings: [newScope],
      administratorGrants: [administratorGrant(newScope)],
      projectGrants: [
        {
          ...evidenceScope(outsideRoot),
          grant_id: "project:outside-ceiling",
          lifetime: "project",
          operation_identity: null,
          expires_at: null,
        },
      ],
    });

    expect(reloaded.ok).toBe(false);
    expect(await canRead(authority.value, oldRoot)).toBe(true);
    expect(await canRead(authority.value, newRoot)).toBe(false);

    expect(
      await authority.value.replaceConfiguredPolicy({
        ceilings: [newScope],
        administratorGrants: [administratorGrant(newScope)],
        projectGrants: [],
      }),
    ).toEqual({ ok: true, value: null });
    expect(await canRead(authority.value, oldRoot)).toBe(false);
    expect(await canRead(authority.value, newRoot)).toBe(true);
  });

  it("isolates transient grants and consumption between live connections", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "rea-permission-session-"));
    const scope = evidenceScope(sandbox);
    const configured = await createPermissionAuthority([scope]);
    expect(configured.ok).toBe(true);
    if (!configured.ok) return;
    const connectionA = configured.value.createConnectionAuthority();
    const connectionB = configured.value.createConnectionAuthority();
    const request = {
      ...scope,
      operation_identity: "read:connection-owned",
    };

    expect(
      connectionA.grant({
        ...request,
        grant_id: "session:a",
        lifetime: "session",
        operation_identity: null,
        expires_at: null,
      }),
    ).toMatchObject({ ok: true });
    expect(await connectionA.authorize(request, "read")).toMatchObject({
      ok: true,
    });
    expect(await connectionB.authorize(request, "read")).toMatchObject({
      ok: false,
    });

    connectionB.clearSessionGrants();
    expect(await connectionA.authorize(request, "read")).toMatchObject({
      ok: true,
    });

    connectionA.clearSessionGrants();
    const onceRequest = {
      ...request,
      operation_identity: "read:once-on-a",
    };
    expect(
      connectionA.grant({
        ...onceRequest,
        grant_id: "once:a",
        lifetime: "once",
        expires_at: null,
      }),
    ).toMatchObject({ ok: true });
    expect(
      connectionB.grant({
        ...onceRequest,
        grant_id: "once:a",
        lifetime: "once",
        expires_at: null,
      }),
    ).toMatchObject({ ok: true });
    const concurrent = await Promise.all([
      connectionA.authorize(onceRequest, "read"),
      connectionA.authorize(onceRequest, "read"),
    ]);
    expect(concurrent.filter(({ ok }) => ok)).toHaveLength(1);
    expect(await connectionB.authorize(onceRequest, "read")).toMatchObject({
      ok: true,
    });
  });

  it("applies configured policy reloads to existing connections", async () => {
    const sandbox = await mkdtemp(
      join(tmpdir(), "rea-permission-live-reload-"),
    );
    const allowedRoot = join(sandbox, "allowed");
    const replacementRoot = join(sandbox, "replacement");
    await Promise.all([mkdir(allowedRoot), mkdir(replacementRoot)]);
    const configured = await createPermissionAuthority([
      evidenceScope(allowedRoot),
    ]);
    expect(configured.ok).toBe(true);
    if (!configured.ok) return;
    const connection = configured.value.createConnectionAuthority();
    expect(
      connection.grant({
        ...evidenceScope(allowedRoot),
        grant_id: "session:before-reload",
        lifetime: "session",
        operation_identity: null,
        expires_at: null,
      }),
    ).toMatchObject({ ok: true });
    expect(await canRead(connection, allowedRoot)).toBe(true);

    const collisionRequest = {
      ...evidenceScope(allowedRoot),
      operation_identity: "read:reload-collision",
    };
    expect(
      connection.grant({
        ...collisionRequest,
        grant_id: "shared-id",
        lifetime: "once",
        expires_at: null,
      }),
    ).toMatchObject({ ok: true });
    expect(await connection.authorize(collisionRequest, "read")).toMatchObject({
      ok: true,
    });
    expect(
      await configured.value.replaceAdministratorGrants([
        {
          ...evidenceScope(allowedRoot),
          grant_id: "shared-id",
          lifetime: "administrator",
          operation_identity: null,
          expires_at: null,
        },
      ]),
    ).toEqual({ ok: true, value: null });
    expect(await connection.authorize(collisionRequest, "read")).toMatchObject({
      ok: true,
    });

    expect(
      await configured.value.reload([evidenceScope(replacementRoot)]),
    ).toEqual({ ok: true, value: null });
    expect(await canRead(connection, allowedRoot)).toBe(false);
  });
});

const evidenceScope = (root: string): PermissionScope => ({
  capability: "evidence_read",
  roots: [root],
  executables: [],
  environment_names: [],
  network: "none",
  mount: false,
});

const administratorGrant = (scope: PermissionScope): PermissionGrant => ({
  ...scope,
  grant_id: "administrator:evidence_read",
  lifetime: "administrator",
  operation_identity: null,
  expires_at: null,
});

const canRead = async (
  authority: PermissionAuthority,
  root: string,
): Promise<boolean> =>
  (
    await authority.explain(
      {
        ...evidenceScope(root),
        operation_identity: `read:${root}`,
      },
      "read",
    )
  ).ok;
