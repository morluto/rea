import { expect, it } from "vitest";

import {
  DENO_SECTION_MAGIC,
  MAX_DENO_METADATA_JSON_BYTES,
  MAX_DENO_TABLE_COUNT,
  parseDenoSectionBytes,
} from "./DenoSectionLayout.js";
import {
  buildDenoSection,
  defaultDenoMetadata,
} from "./DenoStandalone.fixture.js";

const secret = "super-secret-value";

it("parses metadata, tables, remote regions, and embedded configuration", async () => {
  const original = Buffer.from("export const value = 1;\n");
  const transpiled = Buffer.from("transpiled\n");
  const parsed = await parseDenoSectionBytes(
    buildDenoSection({
      metadata: {
        ...defaultDenoMetadata(),
        entrypoint_key: "main.ts",
        argv: ["--quiet"],
        v8_flags: ["--stack-size=1000"],
        permissions: {
          allow_net: ["example.com"],
          allow_env: null,
          allow_read: true,
        },
        unstable_config: { features: ["bare-node-builtins"] },
        app_name: "sample",
        self_extracting: "abc",
        env_vars_from_env_file: { REA_DENO_TOKEN: secret },
        ca_data: [9, 8, 7],
        vfs_case_sensitivity: "i",
      },
      npmSnapshot: Buffer.from("npm"),
      specifiers: [
        { text: "file:///main.ts", id: 0 },
        { text: "https://example.com/mod.ts", id: 1 },
      ],
      redirects: [{ from: 0, to: 1 }],
      remoteModules: [
        {
          specifierId: 1,
          mediaType: 1,
          data: original,
          transpiled,
          validUtf8: true,
        },
      ],
      vfsFileData: original,
    }),
  );
  expect(parsed.metadata).toMatchObject({
    entrypointKey: "main.ts",
    argv: ["--quiet"],
    v8Flags: ["--stack-size=1000"],
    permissions: {
      allow_net: ["example.com"],
      allow_env: null,
      allow_read: true,
    },
    appName: "sample",
    selfExtracting: "abc",
    envVarCount: 1,
    envVars: [
      { name: "REA_DENO_TOKEN", value: secret, valueByteLength: secret.length },
    ],
    caData: [9, 8, 7],
    caDataByteLength: 3,
    vfsCaseSensitivity: "insensitive",
  });
  expect(JSON.stringify(parsed.metadata)).toContain(secret);
  expect(parsed.npmSnapshotByteLength).toBe(3);
  expect(parsed.specifiers).toMatchObject({ count: 2, listing: "listed" });
  expect(parsed.redirects).toMatchObject({ count: 1, listing: "listed" });
  expect(parsed.remoteModules.listing).toBe("listed");
  expect(parsed.remoteModules.modules[0]).toMatchObject({
    specifierId: 1,
    isValidUtf8: true,
    data: { length: original.length },
    transpiled: { length: transpiled.length },
  });
  expect(parsed.specifierText?.get(1)).toBe("https://example.com/mod.ts");
  expect(parsed.vfs.listing).toBe("listed");
  expect(parsed.vfs.members[0]).toMatchObject({
    role: "vfs-file",
    path: "main.ts",
    length: original.length,
  });
});

it("rejects a truncated length and a mismatched closing marker as malformed", async () => {
  await expect(
    parseDenoSectionBytes(buildDenoSection({ metadataLength: 1_000_000 })),
  ).rejects.toMatchObject({
    reason: "format",
    message: expect.stringContaining("overruns"),
  });
  await expect(
    parseDenoSectionBytes(
      buildDenoSection({ closingMagic: Buffer.from("xxxxxxxx") }),
    ),
  ).rejects.toMatchObject({
    reason: "format",
    message: expect.stringContaining("closing marker"),
  });
});

it("treats a missing opening marker as an unsupported layout", async () => {
  await expect(
    parseDenoSectionBytes(buildDenoSection({ openingMagic: null })),
  ).rejects.toMatchObject({
    reason: "unavailable",
    message: expect.stringContaining("opening marker"),
  });
  await expect(parseDenoSectionBytes(Buffer.alloc(4))).rejects.toMatchObject({
    reason: "unavailable",
  });
});

it("refuses metadata JSON above the named allowance before reading it as JSON", async () => {
  const claimed = MAX_DENO_METADATA_JSON_BYTES + 1;
  const bytes = Buffer.alloc(DENO_SECTION_MAGIC.length + 8 + claimed);
  DENO_SECTION_MAGIC.copy(bytes, 0);
  bytes.writeBigUInt64LE(BigInt(claimed), DENO_SECTION_MAGIC.length);
  await expect(parseDenoSectionBytes(bytes)).rejects.toMatchObject({
    reason: "limit",
    message: expect.stringContaining("metadata JSON"),
  });
});

it("refuses a specifier table above the named record allowance", async () => {
  await expect(
    parseDenoSectionBytes(
      buildDenoSection({
        specifiers: [],
        specifierCount: MAX_DENO_TABLE_COUNT + 1,
      }),
    ),
  ).rejects.toMatchObject({
    reason: "limit",
    message: expect.stringContaining("specifier"),
  });
});

it("stops on unrecognized remote flags and duplicate specifier ids", async () => {
  await expect(
    parseDenoSectionBytes(
      buildDenoSection({
        specifiers: [{ text: "file:///main.ts", id: 0 }],
        remoteModules: [{ specifierId: 0, data: "x", flags: 0x80 }],
      }),
    ),
  ).rejects.toMatchObject({
    reason: "unavailable",
    message: expect.stringContaining("flags"),
  });
  await expect(
    parseDenoSectionBytes(
      buildDenoSection({
        specifiers: [
          { text: "file:///a.ts", id: 0 },
          { text: "file:///b.ts", id: 0 },
        ],
      }),
    ),
  ).rejects.toMatchObject({
    reason: "format",
    message: expect.stringContaining("duplicate specifier id"),
  });
});

it("reports an invalid specifier as an unsupported listing", async () => {
  const parsed = await parseDenoSectionBytes(
    buildDenoSection({
      specifiers: [{ bytes: Buffer.from([0xff]), id: 0 }],
    }),
  );
  expect(parsed.specifiers.listing).toBe("unsupported");
  expect(parsed.specifierText).toBeNull();
});

it("keeps decoded specifiers when another remote id is missing", async () => {
  const parsed = await parseDenoSectionBytes(
    buildDenoSection({
      specifiers: [{ text: "https://example.com/mod.ts", id: 1 }],
      remoteModules: [
        { specifierId: 1, data: "known" },
        { specifierId: 2, data: "missing" },
      ],
    }),
  );
  expect(parsed.remoteModules.listing).toBe("unsupported");
  expect(parsed.specifierText?.get(1)).toBe("https://example.com/mod.ts");
  expect(parsed.specifierText?.has(2)).toBe(false);
});

it("honors cancellation before parsing", async () => {
  const controller = new AbortController();
  controller.abort(new Error("stop"));
  await expect(
    parseDenoSectionBytes(buildDenoSection(), controller.signal),
  ).rejects.toMatchObject({ reason: "cancelled" });
});
