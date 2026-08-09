import { createHash } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

import type { PermissionAuthority } from "../../../src/application/PermissionAuthority.js";
import type { ProjectPermissionStore } from "../../../src/application/ProjectPermissionStore.js";
import type { PermissionGrant } from "../../../src/domain/permissionPolicy.js";
import { ok } from "../../../src/domain/result.js";
import { run } from "../../../src/main.js";
import {
  createServer,
  type CreateServerOptions,
} from "../../../src/server/createServer.js";

type RuntimeDependencies = NonNullable<Parameters<typeof run>[0]>;

const directories: string[] = [];
const RELOAD_ASSERTION_TIMEOUT_MS = 5_000;

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("runtime permission reload", () => {
  it("keeps live state unchanged after a late grant failure, then commits together", async () => {
    const fixture = await reloadFixture();
    const invalid = projectStore(fixture.projectRoot, [
      projectGrant("invalid", fixture.outsideRoot),
    ]);
    const valid = projectStore(fixture.projectRoot, [
      projectGrant("valid", fixture.newRoot),
    ]);
    const validReadStarted = deferred<void>();
    const releaseValidRead = deferred<void>();
    let reads = 0;
    const runtime = await startRuntime(fixture.env, async () => {
      reads += 1;
      if (reads === 1) return ok(invalid);
      validReadStarted.resolve();
      await releaseValidRead.promise;
      return ok(valid);
    });

    configure(fixture.env, fixture.newRoot, true);
    runtime.reload();
    runtime.reload();
    await validReadStarted.promise;

    expect(runtime.options.processPolicy?.().status).toBe("disabled");
    expect(runtime.options.evidenceFilePolicy?.roots).toEqual([
      fixture.oldRoot,
    ]);
    expect(runtime.options.artifactIntegrityContinueEnabled?.()).toBe(false);
    expectOptionalPolicies(runtime.options, { status: "disabled" });
    expect(await canRead(runtime.authority, fixture.oldRoot)).toBe(true);
    expect(await canRead(runtime.authority, fixture.newRoot)).toBe(false);

    releaseValidRead.resolve();
    await expect
      .poll(() => canRead(runtime.authority, fixture.newRoot), {
        timeout: RELOAD_ASSERTION_TIMEOUT_MS,
      })
      .toBe(true);

    expect(runtime.options.processPolicy?.().status).toBe("enabled");
    expect(runtime.options.evidenceFilePolicy?.roots).toEqual([
      fixture.newRoot,
    ]);
    expect(runtime.options.artifactIntegrityContinueEnabled?.()).toBe(true);
    expectOptionalPolicies(runtime.options, {
      status: "enabled",
      root: fixture.newRoot,
    });
    expect(await canRead(runtime.authority, fixture.oldRoot)).toBe(false);
    expect(await canRead(runtime.authority, fixture.newRoot)).toBe(true);
  });

  it("serializes overlapping reloads so an older read cannot commit last", async () => {
    const fixture = await reloadFixture();
    const firstReadStarted = deferred<void>();
    const releaseFirstRead = deferred<void>();
    const secondReadStarted = deferred<void>();
    let secondStarted = false;
    let reads = 0;
    const runtime = await startRuntime(fixture.env, async () => {
      reads += 1;
      if (reads === 1) {
        firstReadStarted.resolve();
        await releaseFirstRead.promise;
        return ok(projectStore(fixture.projectRoot, []));
      }
      secondStarted = true;
      secondReadStarted.resolve();
      return ok(projectStore(fixture.projectRoot, []));
    });

    configure(fixture.env, fixture.newRoot, true);
    runtime.reload();
    await firstReadStarted.promise;
    configure(fixture.env, fixture.latestRoot, false);
    runtime.reload();

    expect(secondStarted).toBe(false);
    releaseFirstRead.resolve();
    await secondReadStarted.promise;
    await expect
      .poll(() => canRead(runtime.authority, fixture.latestRoot), {
        timeout: RELOAD_ASSERTION_TIMEOUT_MS,
      })
      .toBe(true);

    expect(runtime.options.processPolicy?.().status).toBe("disabled");
    expect(runtime.options.evidenceFilePolicy?.roots).toEqual([
      fixture.latestRoot,
    ]);
    expect(runtime.options.artifactIntegrityContinueEnabled?.()).toBe(false);
    expectOptionalPolicies(runtime.options, { status: "disabled" });
    expect(await canRead(runtime.authority, fixture.newRoot)).toBe(false);
    expect(await canRead(runtime.authority, fixture.latestRoot)).toBe(true);
  });

  it("continues with later reloads after an unexpected reload rejection", async () => {
    const fixture = await reloadFixture();
    let reads = 0;
    const runtime = await startRuntime(fixture.env, async () => {
      reads += 1;
      if (reads === 1) throw new Error("synthetic unexpected read failure");
      return ok(projectStore(fixture.projectRoot, []));
    });

    configure(fixture.env, fixture.newRoot, true);
    runtime.reload();
    runtime.reload();
    await expect
      .poll(() => reads, { timeout: RELOAD_ASSERTION_TIMEOUT_MS })
      .toBe(2);
    await expect
      .poll(() => canRead(runtime.authority, fixture.newRoot), {
        timeout: RELOAD_ASSERTION_TIMEOUT_MS,
      })
      .toBe(true);

    expect(reads).toBe(2);
    expect(runtime.options.processPolicy?.().status).toBe("enabled");
    expect(runtime.options.evidenceFilePolicy?.roots).toEqual([
      fixture.newRoot,
    ]);
    expect(runtime.options.artifactIntegrityContinueEnabled?.()).toBe(true);
    expectOptionalPolicies(runtime.options, {
      status: "enabled",
      root: fixture.newRoot,
    });
    expect(await canRead(runtime.authority, fixture.oldRoot)).toBe(false);
    expect(await canRead(runtime.authority, fixture.newRoot)).toBe(true);
  });
});

type ExpectedOptionalPolicies =
  | { readonly status: "disabled" }
  | { readonly status: "enabled"; readonly root: string };

const expectOptionalPolicies = (
  options: CreateServerOptions,
  expected: ExpectedOptionalPolicies,
): void => {
  const enabled = expected.status === "enabled";
  expect(options.managedRuntimePolicy?.()).toEqual(
    enabled
      ? {
          status: "enabled",
          roots: [expected.root],
          executablePath: process.execPath,
        }
      : { status: "disabled" },
  );
  expect(options.javascriptReplayPolicy?.()).toMatchObject(
    enabled
      ? { status: "enabled", roots: [expected.root] }
      : { status: "disabled" },
  );
  expect(options.availabilityPolicy?.()).toMatchObject({
    browserObservationEnabled: enabled,
    electronObservationEnabled: enabled,
    v8InspectorObservationEnabled: enabled,
    javascriptReplayEnabled: enabled,
  });
};

const reloadFixture = async () => {
  const directory = await createTestTempDirectory("rea-main-reload-");
  directories.push(directory);
  const oldRoot = join(directory, "old");
  const newRoot = join(directory, "new");
  const latestRoot = join(directory, "latest");
  const outsideRoot = join(directory, "outside");
  const projectRoot = join(directory, "project");
  await Promise.all(
    [oldRoot, newRoot, latestRoot, outsideRoot, projectRoot].map((path) =>
      mkdir(path),
    ),
  );
  const env: NodeJS.ProcessEnv = {
    REA_EVIDENCE_ROOTS_JSON: JSON.stringify([oldRoot]),
    REA_PERMISSION_PROJECT_ROOT: projectRoot,
    REA_PERMISSION_PROJECT_STORE: join(directory, "permissions.json"),
  };
  return { env, oldRoot, newRoot, latestRoot, outsideRoot, projectRoot };
};

const configure = (
  env: NodeJS.ProcessEnv,
  root: string,
  enabled: boolean,
): void => {
  env.REA_EVIDENCE_ROOTS_JSON = JSON.stringify([root]);
  env.REA_PROCESS_CAPTURE_ENABLED = String(enabled);
  env.REA_PROCESS_EXECUTABLE_ROOTS_JSON = JSON.stringify([root]);
  env.REA_PROCESS_WORKING_ROOTS_JSON = JSON.stringify([root]);
  env.REA_ARTIFACT_INTEGRITY_CONTINUE_ENABLED = String(enabled);
  env.REA_MANAGED_RUNTIME_ENABLED = String(enabled);
  env.REA_MANAGED_RUNTIME_ROOTS_JSON = JSON.stringify([root]);
  env.REA_MANAGED_RUNTIME_EXECUTABLE_PATH = process.execPath;
  env.REA_JAVASCRIPT_REPLAY_ENABLED = String(enabled);
  env.REA_JAVASCRIPT_REPLAY_ROOTS_JSON = JSON.stringify([root]);
  env.REA_BROWSER_OBSERVE_ENABLED = String(enabled);
  env.REA_BROWSER_CDP_ENDPOINTS_JSON = JSON.stringify([
    "http://127.0.0.1:9222",
  ]);
  env.REA_BROWSER_ALLOWED_ORIGINS_JSON = JSON.stringify([
    "https://example.test",
  ]);
  env.REA_ELECTRON_OBSERVE_ENABLED = String(enabled);
  env.REA_ELECTRON_CDP_ENDPOINTS_JSON = JSON.stringify([
    "http://127.0.0.1:9223",
  ]);
  env.REA_ELECTRON_FILE_ROOTS_JSON = JSON.stringify([root]);
  env.REA_V8_INSPECTOR_OBSERVE_ENABLED = String(enabled);
  env.REA_V8_INSPECTOR_ENDPOINTS_JSON = JSON.stringify([
    "http://127.0.0.1:9224",
  ]);
  env.REA_V8_INSPECTOR_FILE_ROOTS_JSON = JSON.stringify([root]);
};

const startRuntime = async (
  env: NodeJS.ProcessEnv,
  readStore: NonNullable<RuntimeDependencies["readProjectPermissionStore"]>,
) => {
  let reload: (() => void) | undefined;
  let options: CreateServerOptions | undefined;
  const result = await run({
    env,
    serve: (factory) => {
      void factory({ era: "legacy" });
      return { close: () => Promise.resolve() };
    },
    writeStderr: () => undefined,
    setExitCode: () => undefined,
    registerShutdown: () => () => undefined,
    registerReload: (handler) => {
      reload = handler;
      return () => undefined;
    },
    readProjectPermissionStore: readStore,
    createServer: (analysis, session, received) => {
      options = received;
      return createServer(analysis, session, received);
    },
  });
  expect(result).toBe(0);
  const authority = options?.permissionAuthority;
  if (reload === undefined || options === undefined || authority === undefined)
    throw new Error("Runtime reload seam was not initialized");
  const capturedOptions = options;
  return {
    reload,
    options: capturedOptions,
    authority,
  };
};

const projectStore = (
  projectRoot: string,
  grants: readonly ReturnType<typeof projectGrant>[],
): ProjectPermissionStore => ({
  schema_version: 1,
  project_id: `project_${createHash("sha256").update(projectRoot).digest("hex")}`,
  project_root: projectRoot,
  grants: [...grants],
});

const projectGrant = (id: string, root: string) =>
  ({
    grant_id: `project:${id}`,
    capability: "evidence_read",
    roots: [root],
    executables: [],
    environment_names: [],
    network: "none",
    mount: false,
    lifetime: "project",
    operation_identity: null,
    expires_at: null,
  }) satisfies PermissionGrant;

const canRead = async (
  authority: PermissionAuthority,
  root: string,
): Promise<boolean> =>
  (
    await authority.explain(
      {
        capability: "evidence_read",
        roots: [root],
        executables: [],
        environment_names: [],
        network: "none",
        mount: false,
        operation_identity: `read:${root}`,
      },
      "read",
    )
  ).ok;

const deferred = <T>() => {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
};
