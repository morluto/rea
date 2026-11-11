import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { onTestFinished, vi } from "vitest";
import {
  RegularFileCleanupFailure,
  withOwnedRegularFile,
} from "../../src/filesystem/OwnedRegularFile.js";
import { createTestTempDirectory } from "./temporaryDirectory.js";

/** The production file owner keeps the real descriptor after its controlled close rejection. */
export const failedInspectionDescriptor = async (directory?: string) => {
  const root =
    directory ?? (await createTestTempDirectory("rea-inspection-fd-"));
  const path = join(root, "identity");
  await writeFile(path, "inert inspection bytes");
  let allow = false;
  let closes = 0;
  const cause: unknown = await withOwnedRegularFile(
    path,
    {},
    async ({ handle }) => {
      const close = handle.close.bind(handle);
      vi.spyOn(handle, "close").mockImplementation(async () => {
        closes += 1;
        if (!allow)
          throw new Error("controlled inspection descriptor close failure");
        await close();
      });
      return "completed inspection";
    },
  ).catch((failure: unknown) => failure);
  if (!(cause instanceof RegularFileCleanupFailure))
    throw new Error("Expected the actual file owner's cleanup failure");
  onTestFinished(async () => {
    allow = true;
    await cause.owner.close();
  });
  return {
    failure: cause,
    path,
    handle: cause.owner.handle,
    allow: () => {
      allow = true;
    },
    closes: () => closes,
  };
};
