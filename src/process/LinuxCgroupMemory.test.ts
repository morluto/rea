import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";

import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import {
  readLinuxCgroupAdmissionFacts,
  readLinuxCgroupMemoryState,
} from "./LinuxCgroupMemory.js";
import { OwnedFileHandle } from "../filesystem/OwnedFileHandle.js";
import { RegularFileCleanupFailure } from "../filesystem/OwnedRegularFile.js";

it("retains a failed kernel file close for the caller to retry", async () => {
  const directory = await createTestTempDirectory("rea-cgroup-retained-");
  const path = join(directory, "cgroup");
  await writeFile(path, "0::/jobs/rea\n");
  const failure = new Error("close denied");
  const close = vi
    .spyOn(OwnedFileHandle.prototype, "close")
    .mockRejectedValueOnce(failure);
  let retained: OwnedFileHandle | undefined;
  try {
    await expect(
      readLinuxCgroupMemoryState({
        platform: "linux",
        procCgroupPath: path,
        retainFailedClose: (_path, owner) => {
          retained = owner;
        },
      }),
    ).resolves.toBeUndefined();
    expect(retained).toBeDefined();
    await retained?.close();
    close.mockRejectedValueOnce(failure);
    let unretained: unknown;
    try {
      await readLinuxCgroupMemoryState({
        platform: "linux",
        procCgroupPath: path,
      });
    } catch (cause: unknown) {
      unretained = cause;
    }
    expect(unretained).toBeInstanceOf(RegularFileCleanupFailure);
    if (unretained instanceof RegularFileCleanupFailure)
      await unretained.owner.close();
  } finally {
    close.mockRestore();
    await retained?.close();
  }
});

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

it("does not alias an undecodable cgroup path to a real replacement-character directory", async () => {
  const root = await createTestTempDirectory("rea-cgroup-non-utf8-");
  const group = join(root, "group-�");
  const procCgroupPath = join(root, "proc-self-cgroup");
  const procMountInfoPath = join(root, "proc-self-mountinfo");
  const options = {
    platform: "linux" as const,
    procCgroupPath,
    procMountInfoPath,
  };
  await mkdir(group);
  await writeFile(join(group, "memory.events"), events(12));
  await writeFile(procMountInfoPath, mountInfoRow("/", root));
  const membership = "0::/group-�\n";
  await writeFile(procCgroupPath, membership);
  await expect(readLinuxCgroupMemoryState(options)).resolves.toMatchObject({
    path: "/group-�",
    oomKills: 12,
  });
  await writeFile(
    procCgroupPath,
    Buffer.concat([
      Buffer.from("0::/group-"),
      Buffer.from([0xff]),
      Buffer.from("\n"),
    ]),
  );
  await expect(readLinuxCgroupMemoryState(options)).resolves.toBeUndefined();
});

it("uses valid cgroup mounts alongside unrelated non-UTF-8 mount records", async () => {
  const root = await createTestTempDirectory("rea-cgroup-mount-encoding-");
  const mount = join(root, "mount-�");
  const procCgroupPath = join(root, "proc-self-cgroup");
  const procMountInfoPath = join(root, "proc-self-mountinfo");
  const options = {
    platform: "linux" as const,
    procCgroupPath,
    procMountInfoPath,
  };
  await mkdir(mount);
  await writeFile(join(mount, "memory.events"), events(3));
  await writeFile(procCgroupPath, "0::/\n");
  const valid = mountInfoRow("/", mount);
  const byte = Buffer.from([0xff]);
  const invalidRow = (row: string) => {
    const [prefix, suffix] = row.split("�");
    return Buffer.concat([Buffer.from(prefix!), byte, Buffer.from(suffix!)]);
  };
  await writeFile(
    procMountInfoPath,
    Buffer.concat([
      invalidRow(mountInfoRow("/", "/other-�", "ext4")),
      Buffer.from(`\n${valid}\n`),
    ]),
  );
  await expect(readLinuxCgroupMemoryState(options)).resolves.toMatchObject({
    oomKills: 3,
  });
  await writeFile(procMountInfoPath, invalidRow(valid));
  await expect(readLinuxCgroupMemoryState(options)).resolves.toBeUndefined();
});

it("returns undefined for admission facts when platform is not linux or membership is unreadable", async () => {
  await expect(
    readLinuxCgroupAdmissionFacts({ platform: "darwin" }),
  ).resolves.toBeUndefined();
  await expect(
    readLinuxCgroupAdmissionFacts({
      platform: "linux",
      procCgroupPath: "/nonexistent-cgroup-path",
    }),
  ).resolves.toBeUndefined();
});

it("reads admission facts and tightens effective limit across ancestor hierarchy", async () => {
  const root = await createTestTempDirectory("rea-cgroup-ancestors-");
  const mountPoint = join(root, "cgroup");
  const parentGroup = join(mountPoint, "parent.slice");
  const childGroup = join(parentGroup, "child.slice");
  await mkdir(childGroup, { recursive: true });

  // Grandparent (mountPoint root): 4 GiB
  await writeFile(join(mountPoint, "memory.max"), "4294967296\n");
  // Parent: 1 GiB (tightest ancestor)
  await writeFile(join(parentGroup, "memory.max"), "1073741824\n");
  // Child: max
  await writeFile(join(childGroup, "memory.max"), "max\n");
  await writeFile(join(childGroup, "memory.current"), "524288000\n");

  const procCgroupPath = join(root, "proc-self-cgroup");
  await writeFile(procCgroupPath, "0::/parent.slice/child.slice\n");
  const procMountInfoPath = join(root, "proc-self-mountinfo");
  await writeFile(procMountInfoPath, `${mountInfoRow("/", mountPoint)}\n`);

  const facts = await readLinuxCgroupAdmissionFacts({
    platform: "linux",
    procCgroupPath,
    procMountInfoPath,
  });

  expect(facts).toEqual({
    effectiveMemoryMax: 1073741824,
    usageBytes: 524288000,
    effectiveRemainingBytes: 549453824,
  });
});

it("returns 'max' when no ancestor sets a finite limit and parses invalid current as null", async () => {
  const root = await createTestTempDirectory("rea-cgroup-unlimited-");
  const mountPoint = join(root, "cgroup");
  const group = join(mountPoint, "unlimited.slice");
  await mkdir(group, { recursive: true });

  await writeFile(join(mountPoint, "memory.max"), "max\n");
  await writeFile(join(group, "memory.max"), "max\n");
  await writeFile(join(group, "memory.current"), "not-a-number\n");

  const procCgroupPath = join(root, "proc-self-cgroup");
  await writeFile(procCgroupPath, "0::/unlimited.slice\n");
  const procMountInfoPath = join(root, "proc-self-mountinfo");
  await writeFile(procMountInfoPath, `${mountInfoRow("/", mountPoint)}\n`);

  const facts = await readLinuxCgroupAdmissionFacts({
    platform: "linux",
    procCgroupPath,
    procMountInfoPath,
  });

  expect(facts).toEqual({
    effectiveMemoryMax: "max",
    usageBytes: null,
    effectiveRemainingBytes: null,
  });
});

it("accounts for sibling memory use in parent groups when calculating effective remaining bytes", async () => {
  const root = await createTestTempDirectory("rea-cgroup-siblings-");
  const mountPoint = join(root, "cgroup");
  const parentGroup = join(mountPoint, "parent.slice");
  const childGroup = join(parentGroup, "child.slice");
  await mkdir(childGroup, { recursive: true });

  // Parent has 4 GiB limit and 3 GiB used across all children (including siblings)
  await writeFile(join(parentGroup, "memory.max"), "4294967296\n");
  await writeFile(join(parentGroup, "memory.current"), "3221225472\n");
  // Child has no limit (max) and only uses 256 MiB
  await writeFile(join(childGroup, "memory.max"), "max\n");
  await writeFile(join(childGroup, "memory.current"), "268435456\n");

  const procCgroupPath = join(root, "proc-self-cgroup");
  await writeFile(procCgroupPath, "0::/parent.slice/child.slice\n");
  const procMountInfoPath = join(root, "proc-self-mountinfo");
  await writeFile(procMountInfoPath, `${mountInfoRow("/", mountPoint)}\n`);

  const facts = await readLinuxCgroupAdmissionFacts({
    platform: "linux",
    procCgroupPath,
    procMountInfoPath,
  });

  // Effective remaining must be 4 GiB - 3 GiB = 1 GiB (1073741824 bytes), NOT 4 GiB - 256 MiB
  expect(facts).toEqual({
    effectiveMemoryMax: 4294967296,
    usageBytes: 268435456,
    effectiveRemainingBytes: 1073741824,
  });
});

it("discovers parent limits through wider mounts outside subtree mounts", async () => {
  const root = await createTestTempDirectory("rea-cgroup-wider-mount-");
  const subtreeMount = join(root, "subtree-cgroup");
  const widerMount = join(root, "wider-cgroup");

  // Subtree mount exposes only /jobs/rea
  const leafInSubtree = join(subtreeMount, "rea");
  await mkdir(leafInSubtree, { recursive: true });
  await writeFile(join(leafInSubtree, "memory.max"), "max\n");
  await writeFile(join(leafInSubtree, "memory.current"), "104857600\n");

  // Wider mount exposes root /, containing /jobs with a 2 GiB limit and 500 MiB usage
  const jobsInWider = join(widerMount, "jobs");
  const leafInWider = join(jobsInWider, "rea");
  await mkdir(leafInWider, { recursive: true });
  await writeFile(join(jobsInWider, "memory.max"), "2147483648\n");
  await writeFile(join(jobsInWider, "memory.current"), "524288000\n");
  await writeFile(join(leafInWider, "memory.max"), "max\n");
  await writeFile(join(leafInWider, "memory.current"), "104857600\n");

  const procCgroupPath = join(root, "proc-self-cgroup");
  await writeFile(procCgroupPath, "0::/jobs/rea\n");
  const procMountInfoPath = join(root, "proc-self-mountinfo");
  // Subtree mount has root "/jobs", wider mount has root "/"
  await writeFile(
    procMountInfoPath,
    `${mountInfoRow("/jobs", subtreeMount)}\n${mountInfoRow("/", widerMount)}\n`,
  );

  const facts = await readLinuxCgroupAdmissionFacts({
    platform: "linux",
    procCgroupPath,
    procMountInfoPath,
  });

  // Parent limit on /jobs (2 GiB - 500 MiB = 1623205648 bytes remaining) must be discovered
  expect(facts).toEqual({
    effectiveMemoryMax: 2147483648,
    usageBytes: 104857600,
    effectiveRemainingBytes: 1623195648,
  });
});

it("reads limits from readable subtree mount when wider mount is unreadable", async () => {
  const root = await createTestTempDirectory("rea-cgroup-readable-subtree-");
  const subtreeMount = join(root, "subtree-cgroup");
  const unreadableWiderMount = join(root, "unreadable-wider");

  // Subtree mount exposes /jobs/rea and is readable
  const leafInSubtree = join(subtreeMount, "rea");
  await mkdir(leafInSubtree, { recursive: true });
  await writeFile(join(leafInSubtree, "memory.max"), "1073741824\n");
  await writeFile(join(leafInSubtree, "memory.current"), "268435456\n");

  // Wider mount exposes root /, but does not have the leaf paths
  await mkdir(unreadableWiderMount, { recursive: true });

  const procCgroupPath = join(root, "proc-self-cgroup");
  await writeFile(procCgroupPath, "0::/jobs/rea\n");
  const procMountInfoPath = join(root, "proc-self-mountinfo");
  await writeFile(
    procMountInfoPath,
    `${mountInfoRow("/", unreadableWiderMount)}\n${mountInfoRow("/jobs", subtreeMount)}\n`,
  );

  const facts = await readLinuxCgroupAdmissionFacts({
    platform: "linux",
    procCgroupPath,
    procMountInfoPath,
  });

  expect(facts).toEqual({
    effectiveMemoryMax: 1073741824,
    usageBytes: 268435456,
    effectiveRemainingBytes: 805306368,
  });
});

it("preserves uncertainty when ancestor limit is finite but usage cannot be determined", async () => {
  const root = await createTestTempDirectory("rea-cgroup-uncertain-usage-");
  const mountPoint = join(root, "cgroup");
  const parentGroup = join(mountPoint, "parent.slice");
  const childGroup = join(parentGroup, "child.slice");
  await mkdir(childGroup, { recursive: true });

  await writeFile(join(parentGroup, "memory.max"), "1073741824\n");
  await writeFile(join(childGroup, "memory.max"), "max\n");

  const procCgroupPath = join(root, "proc-self-cgroup");
  await writeFile(procCgroupPath, "0::/parent.slice/child.slice\n");
  const procMountInfoPath = join(root, "proc-self-mountinfo");
  await writeFile(procMountInfoPath, `${mountInfoRow("/", mountPoint)}\n`);

  const facts = await readLinuxCgroupAdmissionFacts({
    platform: "linux",
    procCgroupPath,
    procMountInfoPath,
  });

  expect(facts).toEqual({
    effectiveMemoryMax: 1073741824,
    usageBytes: null,
    effectiveRemainingBytes: null,
  });
});

it("caps remaining allowance by tighter ancestor limits when leaf usage is unreadable", async () => {
  const root = await createTestTempDirectory("rea-cgroup-mixed-read-");
  const mountPoint = join(root, "cgroup");
  const parentGroup = join(mountPoint, "parent.slice");
  const childGroup = join(parentGroup, "child.slice");
  await mkdir(childGroup, { recursive: true });

  // Parent: 8 GiB limit, 2 GiB current usage -> 6 GiB remaining
  await writeFile(join(parentGroup, "memory.max"), "8589934592\n");
  await writeFile(join(parentGroup, "memory.current"), "2147483648\n");

  // Child: 1 GiB limit, unreadable current usage
  await writeFile(join(childGroup, "memory.max"), "1073741824\n");

  const procCgroupPath = join(root, "proc-self-cgroup");
  await writeFile(procCgroupPath, "0::/parent.slice/child.slice\n");
  const procMountInfoPath = join(root, "proc-self-mountinfo");
  await writeFile(procMountInfoPath, `${mountInfoRow("/", mountPoint)}\n`);

  const facts = await readLinuxCgroupAdmissionFacts({
    platform: "linux",
    procCgroupPath,
    procMountInfoPath,
  });

  expect(facts).toEqual({
    effectiveMemoryMax: 1073741824,
    usageBytes: null,
    effectiveRemainingBytes: 1073741824,
  });
});
