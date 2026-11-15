import {
  mkdtemp,
  open,
  rm,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it, vi } from "vitest";

import { ArtifactResourceScope } from "../../../src/artifacts/ArtifactResourceScope.js";
import { PrivateRuntimeRoot } from "../../../src/process/PrivateRuntimeRoot.js";
import {
  AdbInputSnapshotFailure,
  snapshotAdbInput,
} from "../../../src/adb/AdbInputSnapshot.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open) };
});

it("retains and retries a source handle that fails close during admission", async () => {
  const actual =
    await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises",
    );
  const parent = await mkdtemp(join(tmpdir(), "rea-adb-snapshot-test-"));
  const root = await PrivateRuntimeRoot.create({ parent });
  const resources = new ArtifactResourceScope();
  const sourcePath = join(parent, "selected.apk");
  await writeFile(sourcePath, "selected bytes");
  const admissionFailure = new Error("controlled descriptor stat failure");
  const closeFailure = new Error("controlled source close failure");
  let source: FileHandle | undefined;
  let closeAttempts = 0;
  let blockClose = true;
  vi.mocked(open).mockImplementation(async (...args) => {
    const handle = await actual.open(...args);
    if (String(args[0]) !== sourcePath) return handle;
    source = handle;
    vi.spyOn(handle, "stat").mockRejectedValue(admissionFailure);
    const close = handle.close.bind(handle);
    vi.spyOn(handle, "close").mockImplementation(async () => {
      closeAttempts += 1;
      // Both admission and snapshot finalization must retain the same handle.
      if (blockClose) throw closeFailure;
      await close();
    });
    return handle;
  });
  try {
    await expect(
      snapshotAdbInput(sourcePath, root, resources, "install_adb_package"),
    ).rejects.toMatchObject<Partial<AdbInputSnapshotFailure>>({
      primaryCause: admissionFailure,
      cleanupResources: [`${sourcePath} (ADB snapshot source handle)`],
      cleanupCause: expect.objectContaining({ errors: [closeFailure] }),
    });

    expect(source?.fd).toBeGreaterThanOrEqual(0);
    expect(resources.hasPending).toBe(true);
    expect(closeAttempts).toBe(2);
    blockClose = false;
    await resources.retryCleanup();
    expect(resources.hasPending).toBe(false);
    expect(closeAttempts).toBe(3);
    expect(source?.fd).toBe(-1);
  } finally {
    blockClose = false;
    await resources.close();
    // An ownership regression must not leave the test's actual descriptor open.
    if (source !== undefined && source.fd !== -1) await source.close();
    vi.restoreAllMocks();
    await root.close();
    await rm(parent, { recursive: true, force: true });
  }
});
