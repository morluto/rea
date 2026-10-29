import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it } from "vitest";
import { parse } from "plist";

import { inspectBundleKeyedArchive } from "../../../src/artifacts/apple/KeyedArchiveReader.js";
import { plistNestingLimitMessage } from "../../../src/domain/apple/plistValue.js";
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
    // The format owner must reject source depth before recursive decoding
    // exhausts the call stack.
    expect(rejected).toMatchObject({
      reason: "limit",
      message: `Cannot decode selected Foundation keyed archive: ${plistNestingLimitMessage()}`,
    });
  },
);

it.each(["(}", "{)", "(@", "{key @", "(x @", "(x ", "{key ", "{key = x,"])(
  "preserves the pinned OpenStep syntax diagnosis before a deep suffix after %s",
  async (prefix) => {
    const text = prefix + "(".repeat(130);
    let pinned: unknown;
    try {
      parse(text);
    } catch (cause) {
      pinned = cause;
    }
    if (!(pinned instanceof Error) || pinned instanceof RangeError)
      throw new Error(
        "Malformed control must fail in the pinned syntax decoder",
      );
    const root = await createTestTempDirectory("rea-keyed-openstep-malformed-");
    await writeFile(join(root, "Malformed.plist"), text);
    const rejected = await inspectBundleKeyedArchive({
      bundlePath: root,
      targetSha256: "a".repeat(64),
      parameters: { path: "Malformed.plist" },
      platform: "linux",
    }).catch((cause: unknown) => cause);
    expect(rejected).toMatchObject({
      reason: "format",
      message: `Cannot decode selected Foundation keyed archive: ${pinned.message}`,
    });
  },
);

it("retains the limit classification for syntactically valid deep OpenStep values", async () => {
  const root = await createTestTempDirectory("rea-keyed-openstep-limit-");
  await writeFile(
    join(root, "Deep.plist"),
    "(".repeat(129) + "x" + ")".repeat(129),
  );
  const rejected = await inspectBundleKeyedArchive({
    bundlePath: root,
    targetSha256: "a".repeat(64),
    parameters: { path: "Deep.plist" },
    platform: "linux",
  }).catch((cause: unknown) => cause);
  expect(rejected).toMatchObject({
    reason: "limit",
    message: `Cannot decode selected Foundation keyed archive: ${plistNestingLimitMessage()}`,
  });
});

it.each([
  ["array sibling", (deep: string) => `((x),${deep})`],
  ["compound dictionary key", (deep: string) => `{(key)=${deep};}`],
] as const)(
  "retains the named OpenStep depth limit after a completed %s",
  async (_name, document) => {
    const root = await createTestTempDirectory(
      "rea-keyed-openstep-sibling-depth-",
    );
    const deep = "(".repeat(30000) + "x" + ")".repeat(30000);
    await writeFile(join(root, "Deep.plist"), document(deep));
    const rejected = await inspectBundleKeyedArchive({
      bundlePath: root,
      targetSha256: "a".repeat(64),
      parameters: { path: "Deep.plist" },
      platform: "linux",
    }).catch((cause: unknown) => cause);
    expect(rejected).toMatchObject({
      reason: "limit",
      message: `Cannot decode selected Foundation keyed archive: ${plistNestingLimitMessage()}`,
    });
  },
);
