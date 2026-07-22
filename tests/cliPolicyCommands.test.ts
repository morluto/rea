import { execFile } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createTestTempDirectory } from "./fixtures/temporaryDirectory.js";

import {
  readProjectPermissionStore,
  writeProjectPermissionStore,
} from "../src/application/ProjectPermissionStore.js";
import { approvePolicyRevocation } from "../src/cliPolicyCommands.js";

const execute = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("policy revocation approval", () => {
  it("accepts --yes without invoking the interactive prompt", async () => {
    const confirm = vi.fn<() => Promise<boolean>>();

    await expect(
      approvePolicyRevocation({
        approved: true,
        interactive: false,
        grantId: "grant-1",
        confirm,
      }),
    ).resolves.toEqual({ approved: true });
    expect(confirm).not.toHaveBeenCalled();
  });

  it("fails closed for non-interactive revocation without --yes", async () => {
    const confirm = vi.fn<() => Promise<boolean>>();

    await expect(
      approvePolicyRevocation({
        approved: false,
        interactive: false,
        grantId: "grant-1",
        confirm,
      }),
    ).resolves.toEqual({ approved: false, reason: "required" });
    expect(confirm).not.toHaveBeenCalled();
  });

  it.each([
    [true, { approved: true }],
    [false, { approved: false, reason: "cancelled" }],
  ] as const)(
    "uses the interactive decision %s",
    async (decision, expected) => {
      const confirm = vi.fn(() => Promise.resolve(decision));

      await expect(
        approvePolicyRevocation({
          approved: false,
          interactive: true,
          grantId: "grant-1",
          confirm,
        }),
      ).resolves.toEqual(expected);
      expect(confirm).toHaveBeenCalledWith("grant-1");
    },
  );

  it("keeps the packaged project store unchanged until --yes is supplied", async () => {
    const project = await createTestTempDirectory("rea-policy-cli-");
    roots.push(project);
    const store = join(project, ".rea", "permissions.json");
    const grant = {
      grant_id: "project:revoke-me",
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
      await writeProjectPermissionStore(store, project, [grant]),
    ).toMatchObject({
      ok: true,
      value: { grants: [grant] },
    });
    const before = await readFile(store);
    const environment = {
      ...process.env,
      REA_PERMISSION_PROJECT_ROOT: project,
      REA_PERMISSION_PROJECT_STORE: store,
    };

    const denied = await runCli(
      ["policy", "revoke", grant.grant_id, "--json"],
      environment,
    );
    expect(denied.status).toBe(1);
    expect(denied.output).toEqual({
      error:
        "Policy revoke requires confirmation. Rerun interactively or with --yes.",
      grant_id: grant.grant_id,
    });
    expect(await readFile(store)).toEqual(before);

    const approved = await runCli(
      ["policy", "revoke", grant.grant_id, "--yes", "--json"],
      environment,
    );
    expect(approved).toEqual({
      status: 0,
      output: {
        revoked: grant.grant_id,
        reload: "Send SIGHUP to the REA MCP process",
      },
    });
    expect(await readProjectPermissionStore(store, project)).toMatchObject({
      ok: true,
      value: { grants: [] },
    });
  }, 40_000);
});

const runCli = async (
  arguments_: readonly string[],
  environment: NodeJS.ProcessEnv,
): Promise<{ readonly status: number; readonly output: unknown }> => {
  try {
    const { stdout } = await execute(
      process.execPath,
      ["scripts/rea.mjs", ...arguments_],
      { cwd: process.cwd(), env: environment },
    );
    return { status: 0, output: JSON.parse(stdout) };
  } catch (cause: unknown) {
    if (
      typeof cause === "object" &&
      cause !== null &&
      "code" in cause &&
      typeof cause.code === "number" &&
      "stdout" in cause &&
      typeof cause.stdout === "string"
    )
      return { status: cause.code, output: JSON.parse(cause.stdout) };
    throw cause;
  }
};
