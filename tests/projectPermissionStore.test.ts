import { chmod, mkdtemp, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  readProjectPermissionStore,
  revokeProjectPermissionGrant,
  writeProjectPermissionStore,
} from "../src/application/ProjectPermissionStore.js";

describe("project permission store", () => {
  it("persists explicit project grants atomically with owner-only permissions", async () => {
    const project = await mkdtemp(join(tmpdir(), "rea-policy-project-"));
    const path = join(project, ".rea", "permissions.json");
    const grant = {
      grant_id: "project:evidence-read",
      capability: "evidence_read" as const,
      roots: [project],
      executables: [],
      environment_names: [],
      network: "none" as const,
      mount: false,
      lifetime: "project" as const,
      operation_identity: null,
      expires_at: null,
    };

    const written = await writeProjectPermissionStore(path, project, [grant]);
    expect(written.ok).toBe(true);
    expect((await stat(path)).mode & 0o077).toBe(0);
    const loaded = await readProjectPermissionStore(path, project);
    expect(loaded).toMatchObject({
      ok: true,
      value: { grants: [grant] },
    });
  });

  it("rejects stores readable by another user class", async () => {
    const project = await mkdtemp(join(tmpdir(), "rea-policy-mode-"));
    const path = join(project, "permissions.json");
    const written = await writeProjectPermissionStore(path, project, []);
    expect(written.ok).toBe(true);
    await chmod(path, 0o644);

    expect(await readProjectPermissionStore(path, project)).toMatchObject({
      ok: false,
      error: { reason: "not_owner_only" },
    });
  });

  it("binds grants to canonical project identity", async () => {
    const first = await mkdtemp(join(tmpdir(), "rea-policy-first-"));
    const second = await mkdtemp(join(tmpdir(), "rea-policy-second-"));
    const path = join(first, "permissions.json");
    expect((await writeProjectPermissionStore(path, first, [])).ok).toBe(true);

    expect(await readProjectPermissionStore(path, second)).toMatchObject({
      ok: false,
      error: { reason: "invalid" },
    });
  });

  it("rejects a symlink even when its target is owner-only", async () => {
    const project = await mkdtemp(join(tmpdir(), "rea-policy-symlink-"));
    const target = join(project, "target.json");
    const path = join(project, "permissions.json");
    expect((await writeProjectPermissionStore(target, project, [])).ok).toBe(
      true,
    );
    await symlink(target, path);

    expect(await readProjectPermissionStore(path, project)).toMatchObject({
      ok: false,
      error: { reason: "not_owner_only" },
    });
  });

  it("round-trips managed runtime project grants", async () => {
    const project = await mkdtemp(join(tmpdir(), "rea-policy-managed-"));
    const path = join(project, "permissions.json");
    const grant = {
      grant_id: "project:managed-runtime",
      capability: "managed_runtime" as const,
      roots: [project],
      executables: [process.execPath],
      environment_names: [],
      network: "none" as const,
      mount: false,
      lifetime: "project" as const,
      operation_identity: null,
      expires_at: null,
    };

    expect(
      await writeProjectPermissionStore(path, project, [grant]),
    ).toMatchObject({ ok: true, value: { grants: [grant] } });
    expect(await readProjectPermissionStore(path, project)).toMatchObject({
      ok: true,
      value: { grants: [grant] },
    });
  });

  it("classifies malformed JSON as an invalid store", async () => {
    const project = await mkdtemp(join(tmpdir(), "rea-policy-invalid-"));
    const path = join(project, "permissions.json");
    await writeFile(path, "{", { mode: 0o600 });

    expect(await readProjectPermissionStore(path, project)).toMatchObject({
      ok: false,
      error: { reason: "invalid" },
    });
  });

  it("serializes concurrent grant revocations without losing an update", async () => {
    const project = await mkdtemp(join(tmpdir(), "rea-policy-revoke-"));
    const path = join(project, ".rea", "permissions.json");
    const grant = (grantId: string) => ({
      grant_id: grantId,
      capability: "evidence_read" as const,
      roots: [project],
      executables: [],
      environment_names: [],
      network: "none" as const,
      mount: false,
      lifetime: "project" as const,
      operation_identity: null,
      expires_at: null,
    });
    expect(
      (
        await writeProjectPermissionStore(path, project, [
          grant("grant-one"),
          grant("grant-two"),
        ])
      ).ok,
    ).toBe(true);

    const revoked = await Promise.all([
      revokeProjectPermissionGrant(path, project, "grant-one"),
      revokeProjectPermissionGrant(path, project, "grant-two"),
    ]);

    expect(revoked).toEqual([
      { ok: true, value: true },
      { ok: true, value: true },
    ]);
    expect(await readProjectPermissionStore(path, project)).toMatchObject({
      ok: true,
      value: { grants: [] },
    });
  });
});
