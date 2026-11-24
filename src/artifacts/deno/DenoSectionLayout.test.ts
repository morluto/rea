import { expect, it } from "vitest";

import {
  MAX_DENO_REMOTE_BODY_BYTES,
  MAX_DENO_SPECIFIER_TEXT_BYTES,
  parseDenoSection,
} from "./DenoSectionLayout.js";
import {
  buildDenoSection,
  defaultDenoMetadata,
  DENO_FIXTURE_SECTION_MAGIC,
} from "./DenoStandalone.fixture.js";

const secret = "super-secret-value";

const parseDenoSectionBytes = (bytes: Buffer, signal?: AbortSignal) =>
  parseDenoSection(
    bytes.length,
    (offset, length) =>
      Promise.resolve(bytes.subarray(offset, offset + length)),
    signal,
  );

it("parses metadata, tables, remote regions, and embedded configuration", async () => {
  const original = Buffer.from("export const value = 1;\n");
  const transpiled = Buffer.from("transpiled\n");
  const laterSpecifiers = Array.from({ length: 1_024 }, (_, index) => ({
    id: index + 2,
    text: `https://example.com/dependency-${index}.ts`,
  }));
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
        ...laterSpecifiers,
      ],
      redirects: [
        { from: 0, to: 1 },
        ...laterSpecifiers.map(({ id }) => ({ from: id, to: 1 })),
      ],
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
  expect(parsed.npmSnapshotByteLength).toBe(3);
  expect(parsed.specifiers).toMatchObject({ count: 1_026, listing: "listed" });
  expect(parsed.redirects).toEqual({
    count: 1_025,
    byteLength: 8_204,
    listing: "listed",
  });
  expect(parsed.remoteModules.listing).toBe("listed");
  expect(parsed.remoteModules.modules[0]).toMatchObject({
    specifierId: 1,
    isValidUtf8: true,
    data: { length: original.length },
    transpiled: { length: transpiled.length },
  });
  expect(parsed.specifierText.get(1)).toBe("https://example.com/mod.ts");
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
  const claimed = 8 * 1024 * 1024 + 1;
  const bytes = Buffer.alloc(DENO_FIXTURE_SECTION_MAGIC.length + 8 + claimed);
  DENO_FIXTURE_SECTION_MAGIC.copy(bytes, 0);
  bytes.writeBigUInt64LE(BigInt(claimed), DENO_FIXTURE_SECTION_MAGIC.length);
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
        specifierCount: 100_001,
      }),
    ),
  ).rejects.toMatchObject({
    reason: "limit",
    message: expect.stringContaining("specifier"),
  });
});

it.each([
  {
    text: "file:///wire-specifier.ts",
    limit: MAX_DENO_SPECIFIER_TEXT_BYTES,
    field: "specifier text",
  },
  {
    text: "wire-module",
    limit: MAX_DENO_REMOTE_BODY_BYTES,
    field: "remote module",
  },
  {
    text: "wire-transpiled",
    limit: MAX_DENO_REMOTE_BODY_BYTES,
    field: "remote transpiled",
  },
])(
  "validates the $field extent before charging its byte allowance",
  async ({ text, limit, field }) => {
    const bytes = buildDenoSection({
      specifiers: [{ text: "file:///wire-specifier.ts", id: 0 }],
      remoteModules: [
        { specifierId: 0, data: "wire-module", transpiled: "wire-transpiled" },
      ],
    });
    const body = bytes.indexOf(Buffer.from(text));
    expect(body).toBeGreaterThan(4);
    const claimed = limit + 1;
    bytes.writeUInt32LE(claimed, body - 4);
    const read = async (offset: number, length: number) =>
      bytes.subarray(offset, offset + length);
    await expect(parseDenoSection(bytes.length, read)).rejects.toMatchObject({
      reason: "format",
      message: expect.stringContaining(`${field} length overruns`),
    });
    // The same body could fit at this logical section size. The selected
    // allowance must stop the parser before it tries to read the body.
    await expect(
      parseDenoSection(body + claimed + 64, read),
    ).rejects.toMatchObject({
      reason: "limit",
    });
  },
);

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
          { bytes: Buffer.from([0xff]), id: 0 },
          { text: "file:///b.ts", id: 0 },
        ],
      }),
    ),
  ).rejects.toMatchObject({
    reason: "format",
    message: expect.stringContaining("duplicate specifier id"),
  });
});

it("limits unsupported listings to the tables that need invalid specifier text", async () => {
  const parsed = await parseDenoSectionBytes(
    buildDenoSection({
      specifiers: [
        { bytes: Buffer.from([0xff]), id: 0 },
        { text: "https://example.com/mod.ts", id: 1 },
        { text: "https://example.com/start.ts", id: 2 },
      ],
      redirects: [{ from: 2, to: 1 }],
      remoteModules: [{ specifierId: 1, data: "known" }],
    }),
  );
  expect(parsed.specifiers.listing).toBe("unsupported");
  expect(parsed.redirects.listing).toBe("listed");
  expect(parsed.remoteModules.listing).toBe("listed");
  expect(parsed.specifierText.get(0)).toBeNull();
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
  expect(parsed.specifierText.get(1)).toBe("https://example.com/mod.ts");
  expect(parsed.specifierText.has(2)).toBe(false);
});

// Empty snapshots and specifier tables leave only their length words before redirect rows.
const REDIRECT_METADATA = Buffer.from('{"entrypoint_key":"main.ts"}');
const REDIRECT_ROWS =
  DENO_FIXTURE_SECTION_MAGIC.length + 8 + REDIRECT_METADATA.length + 8 + 4 + 4;
const redirectSection = (sources: readonly number[]) =>
  buildDenoSection({
    metadataBytes: REDIRECT_METADATA,
    specifiers: [],
    redirects: sources.map((from) => ({ from, to: 0 })),
  });

it.each([false, true])(
  "reports the first malformed redirect despite a short third row (physical EOF %s)",
  async (physicalEof) => {
    const parseShort = (second: number) => {
      const section = redirectSection([1, second, 1]);
      const acquired = section.subarray(0, REDIRECT_ROWS + 20);
      return parseDenoSection(
        physicalEof ? section.length : acquired.length,
        async (offset, length) => acquired.subarray(offset, offset + length),
      );
    };
    await expect(parseShort(1)).rejects.toMatchObject({
      reason: "format",
      message: expect.stringMatching(/duplicate redirect specifier id 1/iu),
    });
    await expect(parseShort(2)).rejects.toMatchObject({
      reason: "format",
      message: expect.stringMatching(
        physicalEof ? /section read was short/iu : /overruns the section/iu,
      ),
    });
  },
);

it("keeps the redirect count allowance and rejects duplicate IDs across batches", async () => {
  const overCount = redirectSection([]).subarray(0, REDIRECT_ROWS);
  overCount.writeUInt32LE(100_001, REDIRECT_ROWS - 4);
  await expect(parseDenoSectionBytes(overCount)).rejects.toMatchObject({
    reason: "limit",
    fixedAllowance: { limit: 100_000, unit: "records" },
  });
  const sources = Array.from({ length: 1_024 }, (_, index) => index);
  await expect(
    parseDenoSectionBytes(redirectSection([...sources, 0])),
  ).rejects.toMatchObject({
    reason: "format",
    message: expect.stringMatching(/duplicate redirect specifier id 0/iu),
  });
});

it.each([false, true])(
  "retains cancellation during redirect admission (count read %s)",
  async (duringCount) => {
    const controller = new AbortController();
    const reason = Symbol("stop during redirect admission");
    const section = redirectSection([1, 1]);
    const bytes = duringCount ? section.subarray(0, REDIRECT_ROWS) : section;
    const abortAt = duringCount ? REDIRECT_ROWS - 4 : REDIRECT_ROWS;
    await expect(
      parseDenoSection(
        bytes.length,
        async (offset, length) => {
          if (offset === abortAt) controller.abort(reason);
          return bytes.subarray(offset, offset + length);
        },
        controller.signal,
      ),
    ).rejects.toMatchObject({ reason: "cancelled", cause: reason });
  },
);

it("honors cancellation before parsing", async () => {
  const controller = new AbortController();
  controller.abort(new Error("stop"));
  await expect(
    parseDenoSectionBytes(buildDenoSection(), controller.signal),
  ).rejects.toMatchObject({ reason: "cancelled" });
});
