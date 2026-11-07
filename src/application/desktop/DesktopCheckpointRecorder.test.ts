import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import { DesktopContentStore } from "../../desktop/DesktopContentStore.js";
import { CheckpointRecorder } from "./DesktopCheckpointRecorder.js";

const unprivileged = process.platform !== "win32" && process.getuid?.() !== 0;

describe.skipIf(!unprivileged)("CheckpointRecorder", () => {
  it("does not pair a later file version with a digest read from an earlier one", async () => {
    const root = await createTestTempDirectory("desktop-recorder-");
    const home = join(root, "home");
    const directory = join(home, "app");
    const file = join(directory, "state.txt");
    await mkdir(directory, { recursive: true });
    await writeFile(file, "v1");
    await mkdir(join(root, "capture"));
    const store = new DesktopContentStore(join(root, "capture"), 1024, 4096);
    await store.prepare();
    const recorder = new CheckpointRecorder(
      {
        roots: [home],
        contentRoots: [directory],
        stateDirectories: [directory],
        excluded: [],
        maxEntries: 100,
      },
      store,
    );
    await recorder.record("baseline", "baseline", 0);
    // The directory cannot be listed while the file changes.
    await writeFile(file, "version two");
    await chmod(directory, 0o000);
    try {
      await recorder.record("hidden", "request", 1);
    } finally {
      await chmod(directory, 0o755);
    }
    await recorder.record("visible", "request", 2);
    await writeFile(file, "version three!");
    await recorder.record("edited", "request", 3);

    const [, hidden, visible, edited] = recorder.checkpoints;
    expect(hidden?.unconfirmed_changes).toBe(1);
    expect(visible?.changes).toEqual([]);
    expect(edited?.changes).toEqual([
      expect.objectContaining({
        path: file,
        kind: "modified",
        before: expect.objectContaining({ sha256: null }),
      }),
    ]);
  });
});
