import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { toolContract } from "../../src/contracts/toolContracts.js";
import { v8CodeCacheFixture } from "../../src/v8/V8CodeCache.fixture.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { cliTest } from "../support/cli/cliFixture.js";

const outputSchema = toolContract("inspect_v8_code_cache").outputSchema;

cliTest(
  "reports the observed header and payload through the public CLI",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-v8-cli-");
    const path = join(root, "module.jsc");
    const bytes = v8CodeCacheFixture(
      "function add(a, b) { return a + b; } add(1, 2);",
    );
    await writeFile(path, bytes);
    const result = await cli.run({
      arguments: ["inspect-v8-code-cache", path, "--json"],
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const evidence = outputSchema.parse(result.json);
    const report = evidence.normalized_result;
    expect(report.header.magic).toBe(bytes.readUInt32LE(0));
    expect(report.header.magic_build_stable).toBe(0xc0de);
    expect(report.header.fields).toHaveLength(8);
    expect(report.payload.offset).toBe(32);
    expect(report.payload.bytes).toBe(bytes.length - 32);
    expect(report.payload.sha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(report.coverage.status).toBe("complete");
  },
);

cliTest(
  "resolves a relative code cache path against the working directory",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-v8-cli-rel-");
    await writeFile(join(root, "module.jsc"), v8CodeCacheFixture());
    const result = await cli.run({
      arguments: ["inspect-v8-code-cache", "module.jsc", "--json"],
      cwd: root,
    });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(
      outputSchema.parse(result.json).normalized_result.artifact.path,
    ).toBe(join(root, "module.jsc"));
  },
);

cliTest(
  "locates retained printable sequences with byte ranges",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-v8-cli-strings-");
    const path = join(root, "module.jsc");
    const marker = "EMBEDDED_CONFIG_KEY_7c1d";
    const bytes = v8CodeCacheFixture(
      `var settings = { key: "${marker}" }; settings.key;`,
    );
    await writeFile(path, bytes);
    const result = await cli.run({
      arguments: [
        "inspect-v8-code-cache",
        path,
        "--minStringBytes",
        "8",
        "--json",
      ],
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const report = outputSchema.parse(result.json).normalized_result;
    const observation = report.embedded_strings.find((entry) =>
      entry.text.includes(marker),
    );
    expect(observation).toBeDefined();
    expect(observation!.offset).toBeGreaterThanOrEqual(report.payload.offset);
    expect(observation!.offset + observation!.bytes).toBeLessThanOrEqual(
      report.artifact.bytes,
    );
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
