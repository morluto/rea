import * as fs from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { inspectLibraryPackages } from "../../../src/desktop/LibraryPackageInventory.js";
import { elfImage } from "../../../src/domain/desktop/elfImage.fixture.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    lstat: vi.fn(actual.lstat),
    readlink: vi.fn(actual.readlink),
    realpath: vi.fn(actual.realpath),
  };
});
const actual =
  await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
afterEach(() => {
  vi.mocked(fs.lstat).mockReset().mockImplementation(actual.lstat);
  vi.mocked(fs.readlink).mockReset().mockImplementation(actual.readlink);
  vi.mocked(fs.realpath).mockReset().mockImplementation(actual.realpath);
});
const fixture = async () => {
  const root = await createTestTempDirectory("rea-library-cancel-lookup-");
  const bin = join(root, "bin"),
    lib = join(root, "lib"),
    alias = join(root, "alias");
  await Promise.all([fs.mkdir(bin), fs.mkdir(lib)]);
  await Promise.all([
    fs.mkdir(join(lib, "sub")),
    fs.mkdir(join(lib, "nested")),
  ]);
  await fs.symlink("lib", alias);
  await fs.writeFile(join(lib, "nested", "libchoice.so"), elfImage({}));
  const executable = join(bin, "app");
  await fs.writeFile(
    executable,
    elfImage({ needed: [`${alias}/sub/../nested/libchoice.so`] }),
  );
  return { executable, alias, dotLookup: `${alias}/sub/..` };
};

it
  .skipIf(process.platform === "win32")
  .each(["lstat", "readlink", "realpath"] as const)(
  "stops lookup reads after cancellation delivered with %s completion",
  async (stage) => {
    const { executable, alias, dotLookup } = await fixture();
    const controller = new AbortController();
    const reason = new Error("stop lookup");
    let readsAtAbort = -1;
    const cancel = () => {
      readsAtAbort = vi.mocked(fs.lstat).mock.calls.length;
      controller.abort(reason);
    };
    if (stage === "lstat")
      vi.mocked(fs.lstat).mockImplementation(async (...args) => {
        const value = await actual.lstat(...args);
        if (args[0] === alias) cancel();
        return value;
      });
    else if (stage === "readlink")
      vi.mocked(fs.readlink).mockImplementation(async (...args) => {
        const value = await actual.readlink(...args);
        if (args[0] === alias) cancel();
        return value;
      });
    else
      vi.mocked(fs.realpath).mockImplementation(async (...args) => {
        const value = await actual.realpath(...args);
        if (args[0] === dotLookup) cancel();
        return value;
      });
    await expect(
      inspectLibraryPackages(
        executable,
        "app",
        async () => ({ stdout: "", exitCode: 0 }),
        controller.signal,
      ),
    ).rejects.toMatchObject({ reason: "cancelled", cause: reason });
    expect(readsAtAbort).toBeGreaterThanOrEqual(0);
    expect(vi.mocked(fs.lstat).mock.calls.length).toBe(readsAtAbort);
  },
);

it.skipIf(process.platform === "win32")(
  "preserves a physical link-read failure racing cancellation",
  async () => {
    const { executable, alias } = await fixture();
    const controller = new AbortController();
    const failure = Object.assign(new Error("readlink I/O failure"), {
      code: "EIO",
    });
    vi.mocked(fs.readlink).mockImplementation(async (...args) => {
      if (args[0] === alias) {
        controller.abort(new Error("cancel while reading"));
        throw failure;
      }
      return actual.readlink(...args);
    });
    await expect(
      inspectLibraryPackages(
        executable,
        "app",
        async () => ({ stdout: "", exitCode: 0 }),
        controller.signal,
      ),
    ).rejects.toBe(failure);
  },
);
