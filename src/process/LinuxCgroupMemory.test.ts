import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";

import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { readLinuxCgroupMemoryState } from "./LinuxCgroupMemory.js";

const events = (oomKill: number) =>
  `low 0\nhigh 0\nmax 772\noom 3\noom_kill ${String(oomKill)}\noom_group_kill 0\n`;

const mountInfoRow = (root: string, mountPoint: string, type = "cgroup2") =>
  `35 24 0:30 ${root} ${mountPoint} rw,nosuid,nodev,noexec,relatime shared:9 - ${type} cgroup2 rw,nsdelegate`;

/** A cgroup2 mount whose root is `/jobs`, holding this process's group `/jobs/rea`. */
const cgroupTree = async (
  files: Readonly<Record<string, string>>,
  membership = "0::/jobs/rea\n",
  mountRoot = "/jobs",
) => {
  const root = await createTestTempDirectory("rea-cgroup-");
  const mountPoint = join(root, "cgroup");
  await mkdir(join(mountPoint, "rea"), { recursive: true });
  for (const [name, text] of Object.entries(files))
    await writeFile(join(mountPoint, "rea", name), text);
  const procCgroupPath = join(root, "proc-self-cgroup");
  await writeFile(procCgroupPath, membership);
  const procMountInfoPath = join(root, "proc-self-mountinfo");
  await writeFile(
    procMountInfoPath,
    `${mountInfoRow(mountRoot, mountPoint)}\n`,
  );
  return { platform: "linux" as const, procCgroupPath, procMountInfoPath };
};

it.each([
  { membership: "12:memory:/jobs/rea\n", mountRoot: "/jobs" },
  { membership: "0::/jobs/rea\n0::/jobs/rea\n", mountRoot: "/jobs" },
  { membership: "0::jobs/rea\n", mountRoot: "jobs" },
  { membership: "0::/jobs/rea/../rea\n", mountRoot: "/jobs" },
])(
  "rejects invalid cgroup membership $membership",
  async ({ membership, mountRoot }) => {
    const options = await cgroupTree(
      { "memory.events": events(1) },
      membership,
      mountRoot,
    );
    await expect(readLinuxCgroupMemoryState(options)).resolves.toBeUndefined();
  },
);

it("selects the v2 membership among v1 rows", async () => {
  const options = await cgroupTree(
    { "memory.events": events(1) },
    "12:memory:/docker/abc\n0::/jobs/rea\n",
  );
  await expect(readLinuxCgroupMemoryState(options)).resolves.toMatchObject({
    path: "/jobs/rea",
    oomKills: 1,
  });
});

it.each([
  "oom 3\noom_group_kill 2\n",
  "oom_kill 1\noom_kill 2\n",
  "oom_kill 9007199254740992\n",
])("rejects a missing, duplicated, or unsafe kill count: %j", async (value) => {
  const options = await cgroupTree({ "memory.events": value });
  await expect(readLinuxCgroupMemoryState(options)).resolves.toBeUndefined();
});

it("retains an unknown memory limit when the token is malformed", async () => {
  const options = await cgroupTree({
    "memory.events": events(0),
    "memory.max": "3g\n",
  });
  await expect(readLinuxCgroupMemoryState(options)).resolves.toMatchObject({
    memoryMax: null,
  });
});

it("selects the closest covering cgroup2 mount and decodes escaped mount paths", async () => {
  const root = await createTestTempDirectory("rea-cgroup-mounts-");
  const full = join(root, "full");
  const subtree = join(root, "cgroup root");
  await mkdir(join(full, "jobs", "rea"), { recursive: true });
  await mkdir(join(subtree, "rea"), { recursive: true });
  await writeFile(join(full, "jobs", "rea", "memory.events"), events(9));
  await writeFile(join(subtree, "rea", "memory.events"), events(1));
  const procCgroupPath = join(root, "proc-self-cgroup");
  const procMountInfoPath = join(root, "proc-self-mountinfo");
  const options = {
    platform: "linux" as const,
    procCgroupPath,
    procMountInfoPath,
  };
  await writeFile(procCgroupPath, "0::/jobs/rea\n");
  await writeFile(
    procMountInfoPath,
    [
      mountInfoRow("/", full),
      mountInfoRow("/jobs", subtree.replaceAll(" ", "\\040")),
      mountInfoRow("/jobs/rea", join(root, "ignored"), "cgroup"),
    ].join("\n"),
  );
  await expect(readLinuxCgroupMemoryState(options)).resolves.toMatchObject({
    path: "/jobs/rea",
    oomKills: 1,
  });

  await writeFile(join(subtree, "memory.events"), events(2));
  await writeFile(procCgroupPath, "0::/jobs\n");
  await expect(readLinuxCgroupMemoryState(options)).resolves.toMatchObject({
    path: "/jobs",
    oomKills: 2,
  });

  await writeFile(procMountInfoPath, mountInfoRow("/", full));
  await writeFile(procCgroupPath, "0::/jobs/rea\n");
  await expect(readLinuxCgroupMemoryState(options)).resolves.toMatchObject({
    path: "/jobs/rea",
    oomKills: 9,
  });

  await writeFile(join(full, "memory.events"), events(3));
  await writeFile(procCgroupPath, "0::/\n");
  await expect(readLinuxCgroupMemoryState(options)).resolves.toMatchObject({
    path: "/",
    oomKills: 3,
  });

  await writeFile(procMountInfoPath, mountInfoRow("/jobs", subtree));
  await writeFile(procCgroupPath, "0::/jobsite/rea\n");
  await expect(readLinuxCgroupMemoryState(options)).resolves.toBeUndefined();
  await writeFile(procMountInfoPath, "");
  await expect(readLinuxCgroupMemoryState(options)).resolves.toBeUndefined();
});

it("reads the process's own group below a subtree cgroup2 mount", async () => {
  const options = await cgroupTree({
    "memory.events": events(1),
    "memory.max": "3221225472\n",
  });
  await expect(readLinuxCgroupMemoryState(options)).resolves.toEqual({
    path: "/jobs/rea",
    oomKills: 1,
    memoryMax: 3_221_225_472,
  });
});

it("keeps an unlimited group apart from an unreadable limit", async () => {
  const unlimited = await cgroupTree({
    "memory.events": events(0),
    "memory.max": "max\n",
  });
  await expect(readLinuxCgroupMemoryState(unlimited)).resolves.toMatchObject({
    memoryMax: "max",
  });
  const unreadable = await cgroupTree({ "memory.events": events(0) });
  await expect(readLinuxCgroupMemoryState(unreadable)).resolves.toEqual({
    path: "/jobs/rea",
    oomKills: 0,
    memoryMax: null,
  });
});

it("is unavailable without memory.events, a covering mount, cgroup v2, or Linux", async () => {
  const noEvents = await cgroupTree({ "memory.max": "max\n" });
  await expect(readLinuxCgroupMemoryState(noEvents)).resolves.toBeUndefined();
  const outside = await cgroupTree(
    { "memory.events": events(0) },
    "0::/system.slice/rea.service\n",
  );
  await expect(readLinuxCgroupMemoryState(outside)).resolves.toBeUndefined();
  const v1 = await cgroupTree(
    { "memory.events": events(0) },
    "4:memory:/jobs/rea\n",
  );
  await expect(readLinuxCgroupMemoryState(v1)).resolves.toBeUndefined();
  const linux = await cgroupTree({ "memory.events": events(0) });
  await expect(
    readLinuxCgroupMemoryState({ ...linux, platform: "darwin" }),
  ).resolves.toBeUndefined();
});
