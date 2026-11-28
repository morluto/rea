import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { lstat, mkdir, readlink, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

import { readWithoutFifoWriter } from "../../tests/fixtures/fifoInput.js";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import {
  SCENARIO_PROFILE_OWNER_FILE,
  SCENARIO_PROFILE_PREFIX,
  observeScenarioOwnerIdentity,
  reclaimStaleScenarioProfiles,
  writeScenarioProfileOwner,
  type ScenarioOwnerIdentityObservation,
} from "./ScenarioProfileReclamation.js";

const LIVE_PID = 4242;
const OWNER_START_IDENTITY = "owner-start-identity";
const STALE_START_IDENTITY = "stale-owner-start-identity";

const onlyLivePid = (pid: number): boolean => pid === LIVE_PID;
const liveOwner = async (): Promise<ScenarioOwnerIdentityObservation> => ({
  state: "readable",
  identity: OWNER_START_IDENTITY,
});
const staleOwner = async (): Promise<ScenarioOwnerIdentityObservation> => ({
  state: "readable",
  identity: STALE_START_IDENTITY,
});
const goneOwner = async (): Promise<ScenarioOwnerIdentityObservation> => ({
  state: "gone",
});
const unavailableOwner =
  async (): Promise<ScenarioOwnerIdentityObservation> => ({
    state: "unavailable",
  });

type ReclaimOptions = NonNullable<
  Parameters<typeof reclaimStaleScenarioProfiles>[0]
>;

const reclaim = (root: string, options: Omit<ReclaimOptions, "root"> = {}) =>
  reclaimStaleScenarioProfiles({
    root,
    isProcessAlive: onlyLivePid,
    observeIdentity: goneOwner,
    ...options,
  });

const profileDirectory = async (
  root: string,
  name: string,
): Promise<string> => {
  const path = join(root, `${SCENARIO_PROFILE_PREFIX}${name}`);
  await mkdir(path, { recursive: true });
  return path;
};

const writeOwner = async (
  path: string,
  pid = 111,
  observeIdentity = staleOwner,
): Promise<void> => writeScenarioProfileOwner(path, { pid, observeIdentity });

/** Real Chromium POSIX link shapes: only the lock target ends in a pid. */
const writeChromiumSingletonLinks = async (
  path: string,
  browserPid: number,
): Promise<void> => {
  await symlink(`testhost-${String(browserPid)}`, join(path, "SingletonLock"));
  await symlink("7876577841782778734", join(path, "SingletonCookie"));
  await symlink(
    "/tmp/org.chromium.Chromium.v0AoRZ/SingletonSocket",
    join(path, "SingletonSocket"),
  );
};

// lstat never follows a link, so a dangling symlink still counts as present.
const existing = (path: string): Promise<boolean> =>
  lstat(path).then(
    () => true,
    () => false,
  );

it("reclaims a profile whose owner and published Chromium lock are gone", async () => {
  const root = await createTestTempDirectory("rea-scenario-reclaim-");
  const path = await profileDirectory(root, "stale");
  await writeOwner(path);
  await writeChromiumSingletonLinks(path, 222);

  const result = await reclaim(root);

  expect(result.reclaimed).toEqual([path]);
  expect(result.skipped).toEqual([]);
  await expect(existing(path)).resolves.toBe(false);
});

it("keeps a profile whose recorded owner is still live", async () => {
  const root = await createTestTempDirectory("rea-scenario-live-");
  const path = await profileDirectory(root, "live");
  await writeOwner(path, 111, liveOwner);
  await writeChromiumSingletonLinks(path, 222);

  const result = await reclaim(root, { observeIdentity: liveOwner });

  expect(result.reclaimed).toEqual([]);
  expect(result.skipped).toEqual([{ path, reason: "owner is live" }]);
  await expect(existing(path)).resolves.toBe(true);
});

it("treats a reused owner pid as a gone owner", async () => {
  const root = await createTestTempDirectory("rea-scenario-reuse-");
  const path = await profileDirectory(root, "reused");
  await writeOwner(path, LIVE_PID, async () => ({
    state: "readable",
    identity: "original-owner-start",
  }));
  await writeChromiumSingletonLinks(path, 222);

  const result = await reclaim(root, {
    observeIdentity: async () => ({
      state: "readable",
      identity: "unrelated-process-start",
    }),
  });

  expect(result.reclaimed).toEqual([path]);
  await expect(existing(path)).resolves.toBe(false);
});

it("never removes a prefixed directory without this package's owner marker", async () => {
  const root = await createTestTempDirectory("rea-scenario-unowned-");
  const path = await profileDirectory(root, "older-release");

  const result = await reclaim(root);

  expect(result.reclaimed).toEqual([]);
  expect(result.skipped).toEqual([{ path, reason: "no owner marker" }]);
  await expect(existing(path)).resolves.toBe(true);
});

it("keeps a profile whose marker carries no start identity", async () => {
  const root = await createTestTempDirectory("rea-scenario-unidentified-");
  const path = await profileDirectory(root, "unknown-start");
  await writeOwner(path, 111, unavailableOwner);
  await writeChromiumSingletonLinks(path, 222);

  const result = await reclaim(root);

  expect(result.reclaimed).toEqual([]);
  expect(result.skipped).toEqual([{ path, reason: "owner identity unknown" }]);
  await expect(existing(path)).resolves.toBe(true);
});

it("keeps a profile when the owner's start identity cannot be observed", async () => {
  const root = await createTestTempDirectory("rea-scenario-owner-unreadable-");
  const path = await profileDirectory(root, "unknown-observation");
  await writeOwner(path);
  await writeChromiumSingletonLinks(path, 222);

  const result = await reclaim(root, { observeIdentity: unavailableOwner });

  expect(result.reclaimed).toEqual([]);
  expect(result.skipped).toEqual([{ path, reason: "owner identity unknown" }]);
  await expect(existing(path)).resolves.toBe(true);
});

it("keeps a profile whose singleton lock names a live process", async () => {
  const root = await createTestTempDirectory("rea-scenario-held-");
  const path = await profileDirectory(root, "browser-live");
  await writeOwner(path);
  await writeChromiumSingletonLinks(path, LIVE_PID);

  const result = await reclaim(root);

  expect(result.reclaimed).toEqual([]);
  expect(result.skipped).toEqual([{ path, reason: "profile lock is held" }]);
  await expect(existing(path)).resolves.toBe(true);
});

it("keeps a profile whose lock target has no process id", async () => {
  const root = await createTestTempDirectory("rea-scenario-unparsed-");
  const path = await profileDirectory(root, "unparsed-lock");
  await writeOwner(path);
  await symlink("testhost", join(path, "SingletonLock"));

  const result = await reclaim(root);

  expect(result.reclaimed).toEqual([]);
  expect(result.skipped).toEqual([{ path, reason: "profile lock is held" }]);
  await expect(existing(path)).resolves.toBe(true);
});

it("keeps a profile whose auxiliary singleton entry is a regular file", async () => {
  const root = await createTestTempDirectory("rea-scenario-file-entry-");
  const path = await profileDirectory(root, "file-entry");
  await writeOwner(path);
  await symlink("testhost-222", join(path, "SingletonLock"));
  await writeFile(join(path, "SingletonCookie"), "not a symlink");

  const result = await reclaim(root);

  expect(result.reclaimed).toEqual([]);
  expect(result.skipped).toEqual([{ path, reason: "profile lock is held" }]);
  await expect(existing(path)).resolves.toBe(true);
});

it("keeps a profile before Chromium publishes a singleton lock", async () => {
  const root = await createTestTempDirectory("rea-scenario-starting-");
  const path = await profileDirectory(root, "browser-starting");
  await writeOwner(path);
  // An orphaned browser may still be starting: a cookie alone proves nothing.
  await symlink("7876577841782778734", join(path, "SingletonCookie"));

  const result = await reclaim(root);

  expect(result.reclaimed).toEqual([]);
  expect(result.skipped).toEqual([{ path, reason: "profile lock is held" }]);
  await expect(existing(path)).resolves.toBe(true);
});

it("keeps a profile when a singleton entry cannot be inspected", async () => {
  const root = await createTestTempDirectory("rea-scenario-inspect-");
  const path = await profileDirectory(root, "inspection-failed");
  await writeOwner(path);
  await writeChromiumSingletonLinks(path, 222);
  const failingLock = join(path, "SingletonLock");
  const error = Object.assign(new Error("permission denied"), {
    code: "EACCES",
  });

  const result = await reclaim(root, {
    singletonFileSystem: {
      lstat: (entry) =>
        entry === failingLock ? Promise.reject(error) : lstat(entry),
      readlink,
    },
  });

  expect(result.reclaimed).toEqual([]);
  expect(result.skipped).toEqual([{ path, reason: "profile lock is held" }]);
  await expect(existing(path)).resolves.toBe(true);
});

it.skipIf(process.platform === "win32")(
  "does not block the sweep on a named pipe used as the owner marker",
  async () => {
    const root = await createTestTempDirectory("rea-scenario-fifo-");
    const path = await profileDirectory(root, "pipe-marker");
    await promisify(execFile)("mkfifo", [
      join(path, SCENARIO_PROFILE_OWNER_FILE),
    ]);
    await writeChromiumSingletonLinks(path, 222);

    const outcome = await readWithoutFifoWriter(
      join(path, SCENARIO_PROFILE_OWNER_FILE),
      () => reclaim(root),
    );

    if (outcome.state !== "completed")
      throw new Error("Reclamation blocked on the named pipe marker");
    expect(outcome.result.reclaimed).toEqual([]);
    expect(outcome.result.skipped).toEqual([
      { path, reason: "no owner marker" },
    ]);
    await expect(existing(path)).resolves.toBe(true);
  },
);

it("keeps a profile whose marker is a symlink instead of a regular file", async () => {
  const root = await createTestTempDirectory("rea-scenario-marker-link-");
  const path = await profileDirectory(root, "linked-marker");
  const elsewhere = join(root, "owner.json");
  await writeFile(elsewhere, "{}");
  await symlink(elsewhere, join(path, SCENARIO_PROFILE_OWNER_FILE));
  await writeChromiumSingletonLinks(path, 222);

  const result = await reclaim(root);

  expect(result.reclaimed).toEqual([]);
  expect(result.skipped).toEqual([{ path, reason: "no owner marker" }]);
  await expect(existing(path)).resolves.toBe(true);
});

it("ignores other prefixes, plain files, and symlinked directories", async () => {
  const root = await createTestTempDirectory("rea-scenario-foreign-");
  const foreign = join(root, "playwright-artifacts-1");
  await mkdir(foreign, { recursive: true });
  const marker = join(root, `${SCENARIO_PROFILE_PREFIX}file`);
  await writeFile(marker, "not a directory");
  const target = await profileDirectory(root, "target");
  await writeOwner(target);
  await writeChromiumSingletonLinks(target, 222);
  await symlink(target, join(root, `${SCENARIO_PROFILE_PREFIX}link`));

  const result = await reclaim(root);

  expect(result.reclaimed).toEqual([target]);
  await expect(existing(foreign)).resolves.toBe(true);
  await expect(existing(marker)).resolves.toBe(true);
  await expect(
    existing(join(root, `${SCENARIO_PROFILE_PREFIX}link`)),
  ).resolves.toBe(true);
});

it.skipIf(process.platform === "win32")(
  "reclaims a profile owned by a process that really exited",
  async () => {
    const root = await createTestTempDirectory("rea-scenario-real-");
    const path = await profileDirectory(root, "exited-owner");
    const child = spawn(
      process.execPath,
      ["-e", "setTimeout(() => {}, 5000)"],
      {
        stdio: "ignore",
      },
    );
    const pid = child.pid;
    if (pid === undefined) throw new Error("Expected a child process id");
    const observed = await observeScenarioOwnerIdentity(pid);
    expect(observed.state).toBe("readable");
    if (observed.state !== "readable")
      throw new Error("Expected a readable owner identity");
    child.kill("SIGKILL");
    await once(child, "exit");
    await writeOwner(path, pid, async () => observed);
    await writeChromiumSingletonLinks(path, 222);

    const result = await reclaimStaleScenarioProfiles({ root });

    expect(result.reclaimed).toEqual([path]);
    expect(result.skipped).toEqual([]);
  },
);

it.skipIf(process.platform === "win32")(
  "keeps a profile this process owns",
  async () => {
    const root = await createTestTempDirectory("rea-scenario-self-");
    const path = await profileDirectory(root, "self");
    await writeScenarioProfileOwner(path);
    await writeChromiumSingletonLinks(path, 222);

    const result = await reclaimStaleScenarioProfiles({ root });

    expect(result.reclaimed).toEqual([]);
    expect(result.skipped).toEqual([{ path, reason: "owner is live" }]);
    await expect(existing(path)).resolves.toBe(true);
  },
);
