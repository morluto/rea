import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { buildBinary } from "plist";
import { afterEach, expect, it, vi } from "vitest";

import { parseBinaryTarget } from "../../../src/application/BinaryTargetResolver.js";
import { thinMach } from "../../../src/domain/binaryTarget.fixture.js";
import {
  InternalInvariantError,
  invariantViolation,
} from "../../../src/domain/internalInvariant.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

/**
 * No input reaches an invariant site today, so the shared binary plist
 * decoder is replaced with one that reports a broken internal assumption.
 */
const decoder = vi.hoisted(() => ({ broken: false }));

vi.mock(
  "../../../src/domain/apple/binaryPlistMaterializer.js",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../../../src/domain/apple/binaryPlistMaterializer.js")
      >();
    return {
      ...actual,
      decodeBinaryPropertyList: (
        ...args: Parameters<typeof actual.decodeBinaryPropertyList>
      ) => {
        if (decoder.broken)
          throw invariantViolation("Binary plist source plan is missing");
        return actual.decodeBinaryPropertyList(...args);
      },
    };
  },
);

afterEach(() => {
  decoder.broken = false;
});

it.each(["Fixture.app", "Fixture.bundle"])(
  "reports an invariant violation while reading %s's Info.plist as a REA defect, not a bundle failure",
  async (name) => {
    const root = await createTestTempDirectory("rea-bundle-invariant-");
    const bundle = join(root, name);
    await mkdir(join(bundle, "Contents", "MacOS"), { recursive: true });
    await writeFile(
      join(bundle, "Contents", "Info.plist"),
      Buffer.from(buildBinary({ CFBundleExecutable: "Fixture" })),
    );
    await writeFile(
      join(bundle, "Contents", "MacOS", "Fixture"),
      thinMach(0xfeedfacf, 0x0100000c),
    );
    const open = () =>
      parseBinaryTarget(bundle, { cwd: root, hostArchitecture: "arm64" });
    await expect(open()).resolves.toMatchObject({ ok: true });

    decoder.broken = true;
    const rejected = await open().catch((cause: unknown) => cause);

    expect(rejected).toBeInstanceOf(InternalInvariantError);
  },
);
