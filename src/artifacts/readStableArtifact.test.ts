import {
  lstat,
  mkdtemp,
  open,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { readStableArtifact } from "./readStableArtifact.js";

const checkChange = async (
  stage: "before-open" | "after-read" | "symlink-replacement",
): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), "rea-stable-read-"));
  const path = join(root, "selected");
  await writeFile(path, "original evidence");
  let inspected = 0;
  try {
    const reading = readStableArtifact(path, 1024, undefined, {
      async lstat(selected) {
        inspected++;
        if (stage === "after-read" && inspected === 2) await unlink(selected);
        const stat = await lstat(selected, { bigint: true });
        if (inspected === 1 && stage !== "after-read") {
          await unlink(selected);
          if (stage === "symlink-replacement")
            await symlink("missing", selected);
        }
        return stat;
      },
      open,
    });
    await expect(reading).rejects.toMatchObject({ reason: "integrity" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

it.each(["before-open", "after-read"] as const)(
  "retains an actual post-validation %s change as integrity failure",
  checkChange,
);

it.skipIf(process.platform === "win32")(
  "retains a post-validation symlink replacement as an integrity failure",
  () => checkChange("symlink-replacement"),
);

it("keeps initially missing inputs distinguishable from later changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "rea-stable-missing-"));
  try {
    await expect(
      readStableArtifact(join(root, "missing"), 1024),
    ).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
