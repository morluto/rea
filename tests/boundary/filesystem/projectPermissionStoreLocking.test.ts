import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { writeProjectPermissionStore } from "../../../src/application/ProjectPermissionStore.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

describe("permission store write ownership", () => {
  it("preserves the store and live owner when replacement cannot acquire the transaction lock", async () => {
    const project = await createTestTempDirectory("rea-policy-locked-write-");
    const path = join(project, "permissions.json");
    expect((await writeProjectPermissionStore(path, project, [])).ok).toBe(
      true,
    );
    const before = await readFile(path);
    const lockPath = `${path}.lock`;
    const owner = `${process.pid}\n`;
    await writeFile(lockPath, owner, { mode: 0o600 });
    const result = await writeProjectPermissionStore(path, project, [
      {
        grant_id: "project:new",
        capability: "evidence_read",
        roots: [project],
        executables: [],
        environment_names: [],
        network: "none",
        mount: false,
        lifetime: "project",
        operation_identity: null,
        expires_at: null,
      },
    ]);
    expect(result).toMatchObject({ ok: false, error: { reason: "locked" } });
    expect(await readFile(path)).toEqual(before);
    expect(await readFile(lockPath, "utf8")).toBe(owner);
  });
});
