import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseBinaryTarget } from "../../../src/application/BinaryTargetResolver.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

describe("DOS COM admission", () => {
  it.each(["fixture.com", "fixture.hop", "fixture.js", "fixture.bin"])(
    "requires explicit interpretation for %s",
    async (name) => {
      const directory = await createTestTempDirectory("rea-com-target-");
      const path = join(directory, name);
      const bytes = Buffer.from("b83412c3", "hex");
      await writeFile(path, bytes);
      const target = await parseBinaryTarget(
        path,
        directory,
        "arm64",
        undefined,
        "dos-com",
      );
      expect(target).toMatchObject({
        ok: true,
        value: {
          path,
          format: "dos-com",
          kind: "executable",
          architecture: "x86",
          availableArchitectures: ["x86"],
          sha256: createHash("sha256").update(bytes).digest("hex"),
        },
      });
      expect(await readFile(path)).toEqual(bytes);
      const detected = await parseBinaryTarget(path);
      expect(detected.ok && detected.value.format).not.toBe("dos-com");
    },
  );
  it.each([0, 0xff01])("rejects invalid file extent %i", async (length) => {
    const directory = await createTestTempDirectory("rea-com-target-");
    const path = join(directory, "fixture.com");
    await writeFile(path, Buffer.alloc(length));
    expect(
      await parseBinaryTarget(path, directory, "x64", undefined, "dos-com"),
    ).toMatchObject({ ok: false, error: { _tag: "BinaryTargetError" } });
  });
  it("rejects contradictory target kind", async () => {
    const directory = await createTestTempDirectory("rea-com-target-");
    const path = join(directory, "fixture.com");
    await writeFile(path, Buffer.from("c3", "hex"));
    expect(
      await parseBinaryTarget(path, directory, "x64", "database", "dos-com"),
    ).toMatchObject({ ok: false, error: { _tag: "BinaryTargetError" } });
  });
});
