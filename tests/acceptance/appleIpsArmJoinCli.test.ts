import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import {
  fatImage,
  machoImage,
} from "../../src/artifacts/apple/MachoImage.fixture.js";
import { toolContract } from "../../src/contracts/toolContracts.js";
import { appleIpsBytes } from "../fixtures/binaryDiagnostics/appleIps.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { cliTest, runFileCli } from "../support/cli/cliFixture.js";

/** Actual 32-bit framing; the displayed family alone cannot identify its subtype. */
const armImage = (subtype: number, withUuid = true): Uint8Array => {
  const text = Buffer.alloc(56);
  text.writeUInt32LE(1, 0); // LC_SEGMENT, not LC_SEGMENT_64.
  text.writeUInt32LE(text.length, 4);
  text.write("__TEXT", 8);
  text.writeUInt32LE(0x1000, 24);
  text.writeUInt32LE(0x4000, 28);
  const uuid = Buffer.alloc(24, 0xaa);
  uuid.writeUInt32LE(0x1b, 0);
  uuid.writeUInt32LE(uuid.length, 4);
  return machoImage({
    cpu: { type: 12, subtype },
    wide: false,
    commands: withUuid ? [text, uuid] : [text],
  });
};

cliTest.for([
  { arch: "armv7", subtype: 9, outcome: "joined" },
  { arch: "armv7s", subtype: 11, outcome: "joined" },
  { arch: "armv7", subtype: 0x80000009, outcome: "joined" },
  { arch: "armv7s", subtype: 0x8000000b, outcome: "joined" },
  { arch: "arm", subtype: 0, outcome: "joined" },
  { arch: "armv7", subtype: 11, outcome: "mismatch" },
  { arch: "armv7s", subtype: 9, outcome: "mismatch" },
  { arch: "arm", subtype: 9, outcome: "joined" },
  { arch: "arm", subtype: 6, outcome: "joined" },
  { arch: "arm", subtype: 99, outcome: "unknown" },
  { arch: "armv7", subtype: 99, outcome: "unknown" },
  { arch: "x86_64", subtype: 99, outcome: "mismatch" },
])(
  "joins IPS $arch with ARM subtype $subtype only on established identity ($outcome)",
  async ({ arch, subtype, outcome }, { cli }) => {
    const root = await createTestTempDirectory("rea-ips-arm-identity-");
    const path = join(root, "report.ips");
    const image = join(root, "image.bin");
    await writeFile(path, appleIpsBytes({ arch, base: 0x8000 }));
    await writeFile(image, armImage(subtype));
    const result = await runFileCli(cli, {
      arguments: ["inspect-apple-ips", path, "--join-path", image, "--json"],
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const report = toolContract("inspect_apple_ips").outputSchema.parse(
      result.json,
    ).normalized_result;
    expect(report.images[0]?.arch).toBe(arch);
    expect(report.join?.status).toBe("selected");
    if (report.join?.status !== "selected") throw new Error("Missing join");
    expect(report.join.slices[0]).toMatchObject({
      arch: "arm",
      cpu_type: "0xc",
      cpu_subtype: `0x${subtype.toString(16)}`,
    });
    expect(report.join.image_matches).toHaveLength(
      outcome === "joined" ? 1 : 0,
    );
    expect(report.join.frames[0]).toMatchObject(
      outcome === "joined"
        ? {
            status: "joined",
            static_address: { decimal: "4920", hex: "0x1338" },
          }
        : { status: "unjoined", static_address: null },
    );
    if (outcome !== "joined")
      expect(report.join.limitations.join(" ")).toContain(
        outcome === "unknown" ? "architecture is unknown" : "does not match",
      );
  },
);

cliTest.for([11, 99])(
  "keeps UUID-less ARM subtype %s relevant unless its identity rules out a match",
  async (subtype, { cli }) => {
    const root = await createTestTempDirectory("rea-ips-arm-uuid-");
    const path = join(root, "report.ips");
    const image = join(root, "universal.bin");
    await writeFile(path, appleIpsBytes({ arch: "armv7", base: 0x8000 }));
    await writeFile(
      image,
      fatImage([
        { cpu: { type: 12, subtype: 9 }, bytes: armImage(9) },
        { cpu: { type: 12, subtype }, bytes: armImage(subtype, false) },
      ]),
    );
    const result = await runFileCli(cli, {
      arguments: ["inspect-apple-ips", path, "--join-path", image, "--json"],
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const report = toolContract("inspect_apple_ips").outputSchema.parse(
      result.json,
    ).normalized_result;
    if (report.join?.status !== "selected") throw new Error("Missing join");
    expect(report.join.slices).toHaveLength(2);
    expect(report.join.slices[1]?.uuid).toBeNull();
    expect(report.join.image_matches).toHaveLength(subtype === 11 ? 1 : 0);
    expect(report.join.frames[0]?.status).toBe(
      subtype === 11 ? "joined" : "unjoined",
    );
    if (subtype === 99)
      expect(report.join.limitations.join(" ")).toContain("UUID is unknown");
  },
);
