import { chmod, mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  readProjectPermissionStore,
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
});
