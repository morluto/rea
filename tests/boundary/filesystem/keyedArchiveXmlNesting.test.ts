import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it } from "vitest";

import { inspectBundleKeyedArchive } from "../../../src/artifacts/apple/KeyedArchiveReader.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { deeplyNestedXmlPlist } from "../../fixtures/keyedArchiveXmlNesting.js";

it.each([129, 3000])(
  "reports XML nesting of %i levels as the keyed archive decode limit",
  async (depth) => {
    const root = await createTestTempDirectory("rea-keyed-depth-");
    await writeFile(join(root, "Deep.plist"), deeplyNestedXmlPlist(depth));
    const rejected = await inspectBundleKeyedArchive({
      bundlePath: root,
      targetSha256: "a".repeat(64),
      parameters: { path: "Deep.plist" },
      platform: "linux",
    }).catch((cause: unknown) => cause);
    // Recursive decoding exhausts the call stack before the projection limit
    // can report it, so the limit diagnostic must come from the preflight.
    expect(rejected).toMatchObject({
      reason: "limit",
      message:
        "Cannot decode selected Foundation keyed archive: Plist exceeds 128 nesting levels",
    });
  },
);
