import { mkdir, chmod, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

// Pass-through except for one name, so the transient (EIO) branch is reachable
// without a host fault; every other probe here uses the real filesystem.
vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...fs,
    stat: async (...args: Parameters<typeof fs.stat>) => {
      if (String(args[0]).endsWith("transient.so"))
        throw Object.assign(new Error("injected I/O failure"), {
          code: "EIO",
        });
      return fs.stat(...args);
    },
  };
});

import { hostFileKind, probeHostFile } from "./HostFileRead.js";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";

describe.skipIf(process.platform === "win32")("probeHostFile", () => {
  it("keeps a name the filesystem refuses to look up in its search position", async () => {
    // glibc's open_path searches past only ENOENT and EACCES; ENAMETOOLONG
    // fails the load there, so the candidate stays an unresolved check.
    const root = await createTestTempDirectory("rea-host-file-probe-");
    const long = join(root, "x".repeat(300), "libcore.so");
    await expect(probeHostFile(long)).resolves.toEqual({
      kind: "unknown",
      unreachable: false,
    });
  });

  it("keeps a looping symlink chain in its search position", async () => {
    // Observed with glibc 2.36: a RUNPATH candidate whose link chain loops
    // ends the search instead of falling through to the next directory.
    const root = await createTestTempDirectory("rea-host-file-probe-");
    const first = join(root, "first.so");
    const second = join(root, "second.so");
    await symlink(second, first);
    await symlink(first, second);
    await expect(probeHostFile(first)).resolves.toEqual({
      kind: "unknown",
      unreachable: false,
    });
  });

  it("reports a readable regular file as a file", async () => {
    const root = await createTestTempDirectory("rea-host-file-probe-");
    const path = join(root, "libcore.so");
    await writeFile(path, "carrier");
    await expect(probeHostFile(path)).resolves.toEqual({
      kind: "file",
      isFile: true,
    });
  });

  it.skipIf(process.getuid?.() === 0)("settles a denied folder", async () => {
    const root = await createTestTempDirectory("rea-host-file-probe-");
    const denied = join(root, "denied");
    await mkdir(denied);
    await writeFile(join(denied, "libcore.so"), "carrier");
    await chmod(denied, 0o000);
    try {
      await expect(probeHostFile(join(denied, "libcore.so"))).resolves.toEqual({
        kind: "unknown",
        unreachable: true,
      });
    } finally {
      await chmod(denied, 0o755);
    }
  });
});

it("keeps a transient stat failure unresolved rather than absent", async () => {
  // EIO neither proves absence nor lets ld.so search past the candidate.
  await expect(probeHostFile("/fixture/lib/transient.so")).resolves.toEqual({
    kind: "unknown",
    unreachable: false,
  });
  await expect(hostFileKind("/fixture/lib/transient.so")).resolves.toBeNull();
});
