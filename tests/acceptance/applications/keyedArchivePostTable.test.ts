import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

// Inert NSKeyedArchiver fixture: the final string follows the offset table.
const source = Buffer.from(
  "YnBsaXN0MDBVJG51bGzUAwUGBwQICQtZJGFyY2hpdmVyXxAPTlNLZXllZEFyY2hpdmVyWCRvYmplY3RzVCR0b3BYJHZlcnNpb26iAAHRCgxUcm9vdBIAAYaggAEAAAgAAIMAAA4AABcAACEAADMAADwAAEEAAEoAAE0AAFAAAFUAAFpVaGVsbG8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADAQAAAAAAAAANAAAAAAAAAAIAAAAAAAAAXA==",
  "base64",
);

const fixture = (width: number, postTable: boolean): Buffer => {
  const oldTable = 92;
  const count = 13;
  const oldEnd = oldTable + count * 3;
  const trailer = source.length - 32;
  const content = source.subarray(oldEnd, trailer);
  const table = postTable ? oldTable : oldTable + content.length;
  const result = Buffer.alloc(trailer - count * 3 + count * width + 32);
  source.copy(result, 0, 0, oldTable);
  content.copy(result, postTable ? table + count * width : oldTable);
  for (let i = 0; i < count; i += 1) {
    const value = source.readUIntBE(oldTable + i * 3, 3);
    const relocated =
      value === oldEnd ? (postTable ? table + count * width : oldTable) : value;
    result.writeUIntBE(relocated, table + i * width, width);
  }
  const newTrailer = result.length - 32;
  source.copy(result, newTrailer, trailer);
  result[newTrailer + 6] = width;
  result.writeBigUInt64BE(BigInt(table), newTrailer + 24);
  return result;
};

cliTest(
  "preserves post-table keyed archive strings through offset normalization",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-keyed-post-table-");
    for (const [width, postTable] of [
      [1, true],
      [3, true],
      [4, true],
      [3, false],
    ] as const) {
      const path = join(root, `${width}-${String(postTable)}.bplist`);
      const original = fixture(width, postTable);
      await writeFile(path, original);
      const result = await cli.run({
        arguments: ["inspect-keyed-archive", path, "--format", "json"],
      });
      expect(result.exitCode, result.stderr).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.normalized_result.objects[1]).toMatchObject({
        status: "observed",
        value: "hello",
      });
      expect((await readFile(path)).equals(original)).toBe(true);
    }
  },
);

cliTest(
  "preserves pre-table integer precision when a string follows the offset table",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-keyed-post-table-int-");
    const path = join(root, "archive.bplist");
    const original = Buffer.from(
      "62706c6973743030d4010203040506070b59246172636869766572582476657273696f6e58246f626a656374735424746f705f100f4e534b65796564417263686976657212000186a0a308090a55246e756c6c5568656c6c6f130020000000000001d10c0d54726f6f74800208111b242d3244494d7a5962656a5568656c6c6f0000000000000101000000000000000e0000000000000000000000000000006c",
      "hex",
    );
    await writeFile(path, original);
    const result = await cli.run({
      arguments: ["inspect-keyed-archive", path, "--format", "json"],
    });
    expect(result.exitCode, result.stderr).toBe(0);
    const json = JSON.parse(result.stdout);
    expect(json.normalized_result.objects[1]).toMatchObject({
      status: "observed",
      value: "hello",
    });
    expect(json.normalized_result.objects[2]).toMatchObject({
      status: "observed",
      value: {
        $plist_type: "integer",
        decimal: "9007199254740993",
      },
    });
    expect(json.normalized_result.limitations).not.toContainEqual(
      expect.stringMatching(/metadata could not be completely observed/u),
    );
    expect((await readFile(path)).equals(original)).toBe(true);
  },
);
