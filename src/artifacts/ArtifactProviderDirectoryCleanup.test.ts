import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import type { RetainedResourceScope } from "../ports/AnalysisProvider.js";
import { DirectoryArtifactReader } from "../resources/DirectoryArtifactReader.js";
import { ArtifactProvider } from "./ArtifactProvider.js";

afterEach(() => {
  vi.restoreAllMocks();
});

it("keeps a directory inspection's failed cleanup retryable by the caller's lifetime", async () => {
  const root = await createTestTempDirectory("rea-directory-cleanup-retry-");
  await writeFile(join(root, "member.bin"), "member");
  const close = vi
    .spyOn(DirectoryArtifactReader.prototype, "close")
    .mockRejectedValue(new Error("directory handle would not close"));
  const retained: { close(): Promise<void> }[] = [];
  const lifetime: RetainedResourceScope = {
    retain: (owner) => retained.push(owner),
    run: (operation) => operation(),
  };

  const inspected = await new ArtifactProvider({}).inspectDirectory(
    root,
    {},
    {},
    lifetime,
  );

  expect(inspected.ok).toBe(false);
  if (inspected.ok) return;
  expect(inspected.error.cleanupResources?.length ?? 0).toBeGreaterThan(0);
  expect(retained).toHaveLength(1);
  const [owner] = retained;
  // The owner stays retained while its cleanup keeps failing.
  await expect(owner?.close()).rejects.toThrow();
  close.mockRestore();
  // A later close of the caller's lifetime releases exactly what remained.
  await expect(owner?.close()).resolves.toBeUndefined();
});

it("retains nothing when the inspection's cleanup succeeds", async () => {
  const root = await createTestTempDirectory("rea-directory-cleanup-clean-");
  await writeFile(join(root, "member.bin"), "member");
  const retained: unknown[] = [];
  const inspected = await new ArtifactProvider({}).inspectDirectory(
    root,
    {},
    {},
    {
      retain: (owner) => retained.push(owner),
      run: (operation) => operation(),
    },
  );
  expect(inspected.ok).toBe(true);
  expect(retained).toEqual([]);
});
