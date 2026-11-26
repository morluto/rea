import { createHash } from "node:crypto";
import { sha256 as digest } from "../support/sha256.js";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { toolContract } from "../../src/contracts/toolContracts.js";
import {
  v8CodeCacheFixture,
  withSyntheticLegacyHeader,
  withSyntheticNarrowHeader,
} from "../../src/v8/V8CodeCache.fixture.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { cliTest } from "../support/cli/cliFixture.js";

const outputSchema = toolContract("inspect_v8_code_cache").outputSchema;

cliTest(
  "reports wide, synthetic narrow and synthetic six-word header extents through the public CLI",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-v8-cli-");
    const marker = "EMBEDDED_CONFIG_KEY_7c1d";
    const wide = v8CodeCacheFixture(
      `var settings = { key: "${marker}" }; settings.key;`,
    );
    const payloadDigest = digest(wide.subarray(32));
    for (const [bytes, headerBytes] of [
      [wide, 32],
      [withSyntheticNarrowHeader(wide), 28],
      [withSyntheticLegacyHeader(wide), 24],
    ] as const) {
      const name = `header-${String(headerBytes)}.jsc`;
      const path = join(root, name);
      await writeFile(path, bytes);
      const result = await cli.run({
        arguments: [
          "inspect-v8-code-cache",
          headerBytes === 32 ? name : path,
          "--min-string-bytes",
          "8",
          "--json",
        ],
        cwd: root,
      });
      expect(result.exitCode, result.stderr).toBe(0);
      const report = outputSchema.parse(result.json).normalized_result;
      expect(report.artifact).toEqual({
        path,
        bytes: bytes.length,
        sha256: digest(bytes),
      });
      expect(report.header.magic).toBe(bytes.readUInt32LE(0));
      expect(report.header.magic_build_stable).toBe(0xc0de);
      expect(report.header.header_bytes).toBe(headerBytes);
      expect(report.header.fields).toHaveLength(headerBytes / 4);
      expect(report.payload).toMatchObject({
        offset: headerBytes,
        bytes: bytes.length - headerBytes,
        sha256: payloadDigest,
      });
      expect(report.coverage.status).toBe("complete");
      const observation = report.embedded_strings.find((entry) =>
        entry.text.includes(marker),
      );
      if (observation === undefined)
        throw new Error("Missing printable marker");
      expect(
        bytes
          .subarray(
            observation.offset,
            observation.offset + observation.retained_bytes,
          )
          .toString("latin1"),
      ).toBe(observation.text);
    }
  },
);

cliTest(
  "fails closed on a file that is not a V8 code cache",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-v8-cli-foreign-");
    const path = join(root, "random.bin");
    const foreign = Buffer.from(v8CodeCacheFixture());
    foreign.writeUInt32LE(0xdeadbeef, 0);
    await writeFile(path, foreign);
    const result = await cli.run({
      arguments: ["inspect-v8-code-cache", path, "--json"],
    });
    expect(result.exitCode).toBe(1);
    expect(result.json).toMatchObject({
      code: "unsupported_target",
      details: {
        operation: "inspect_v8_code_cache",
        partial_observation: {
          kind: "file-snapshot-hash",
          path,
          bytes: foreign.length,
          sha256: createHash("sha256").update(foreign).digest("hex"),
        },
      },
    });
  },
);

cliTest(
  "retains file identity when a synthetic cache exceeds the string budget",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-v8-budget-");
    const path = join(root, "synthetic.jsc");
    const payload = Buffer.from("aaaa\0bbbb");
    const bytes = Buffer.concat([
      v8CodeCacheFixture().subarray(0, 32),
      payload,
    ]);
    bytes.writeUInt32LE(payload.length, 20);
    await writeFile(path, bytes);
    const result = await cli.run({
      arguments: [
        "inspect-v8-code-cache",
        path,
        "--max-strings",
        "1",
        "--min-string-bytes",
        "4",
        "--json",
      ],
    });
    expect(result.exitCode, result.stderr).toBe(1);
    expect(result.json).toMatchObject({
      code: "resource_constraint",
      details: {
        reported_limits: { boundary: "max_strings", maximum: 1 },
        partial_observation: {
          kind: "file-snapshot-hash",
          path,
          bytes: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        },
      },
    });
  },
);
