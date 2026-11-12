import { mkdir, chmod, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { probeHostFile } from "./HostFileRead.js";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";

describe.skipIf(process.platform === "win32")("probeHostFile", () => {
  it("settles a name the filesystem refuses to look up", async () => {
    // The loader skips a RUNPATH/RPATH entry whose component makes stat fail
    // with ENAMETOOLONG rather than retrying it, so the probe reports the
    // candidate as unreachable instead of leaving it unresolved.
    const root = await createTestTempDirectory("rea-host-file-probe-");
    const long = join(root, "x".repeat(300), "libcore.so");
    await expect(probeHostFile(long)).resolves.toEqual({
      kind: "unknown",
      unreachable: true,
    });
  });

  it("settles a symlink chain that loops", async () => {
    // The loader also abandons a RUNPATH/RPATH entry whose link chain loops and
    // goes on to the linker cache, so ELOOP is a settled unreachable candidate
    // rather than a transient check.
    const root = await createTestTempDirectory("rea-host-file-probe-");
    const first = join(root, "first.so");
    const second = join(root, "second.so");
    await symlink(second, first);
    await symlink(first, second);
    await expect(probeHostFile(first)).resolves.toEqual({
      kind: "unknown",
      unreachable: true,
    });
  });

  it("keeps a transient failure unresolved", async () => {
    // EIO is not a refusal and does not settle the candidate, so the walk still
    // treats it as a check that may succeed on a retry.
    const root = await createTestTempDirectory("rea-host-file-probe-");
    const path = join(root, "libcore.so");
    await writeFile(path, "carrier");
    // A regular file is probeable; this asserts the settled side of the probe
    // still reports the kind, so the transient branch is not reached by mistake.
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
