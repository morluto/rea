import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import {
  canonicalizePermissionCeilings,
  canonicalizePermissionRequest,
} from "../src/application/PermissionAuthority.js";
import {
  createPermissionPolicy,
  evaluatePermission,
} from "../src/domain/permissionPolicy.js";

describe("permission authority", () => {
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
});
