import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  readProjectPermissionStore,
  writeProjectPermissionStore,
} from "../src/application/ProjectPermissionStore.js";

const execFileAsync = promisify(execFile);
const CLI_INTEGRATION_TIMEOUT_MS = 60_000;
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("policy CLI revocation", () => {
  it(
    "requires confirmation in structured mode and accepts explicit approval",
    async () => {
      const project = await mkdtemp(join(tmpdir(), "rea-policy-cli-"));
      roots.push(project);
      const store = join(project, ".rea", "permissions.json");
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
      expect(
        (await writeProjectPermissionStore(store, project, [grant])).ok,
      ).toBe(true);
      const environment = {
        ...process.env,
        REA_PERMISSION_PROJECT_ROOT: project,
        REA_PERMISSION_PROJECT_STORE: store,
      };

      const unapproved = await execFileAsync(
        process.execPath,
        ["scripts/rea.mjs", "--json", "policy", "revoke", grant.grant_id],
        { cwd: process.cwd(), env: environment },
      ).catch((cause: unknown) => cause);
      expect(unapproved).toMatchObject({ code: 1, stderr: "" });
      expect(
        JSON.parse((unapproved as { readonly stdout: string }).stdout),
      ).toEqual({
        error: "ConfirmationRequired",
        message: "Policy grant revocation requires confirmation",
        grant_id: grant.grant_id,
        remediation:
          "Verify the grant ID, then rerun the same command with --yes.",
      });
      expect(await readProjectPermissionStore(store, project)).toMatchObject({
        ok: true,
        value: { grants: [grant] },
      });

      const approved = await execFileAsync(
        process.execPath,
        [
          "scripts/rea.mjs",
          "--json",
          "policy",
          "revoke",
          grant.grant_id,
          "--yes",
        ],
        { cwd: process.cwd(), env: environment },
      );
      expect(JSON.parse(approved.stdout)).toEqual({
        revoked: grant.grant_id,
        reload: "Send SIGHUP to the REA MCP process",
      });
      expect(await readProjectPermissionStore(store, project)).toMatchObject({
        ok: true,
        value: { grants: [] },
      });
    },
    CLI_INTEGRATION_TIMEOUT_MS,
  );
});
