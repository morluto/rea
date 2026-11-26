import { deflateSync } from "node:zlib";
import { expect, it } from "vitest";
import { rustAuditableMetadataSchema } from "../domain/rust/rustBinary.js";
import { ParseFailureError } from "../domain/parseFailure.js";

import { readAuditableSectionFromReader } from "./RustAuditableReader.js";

// Explicit 1 MiB input boundary, independent of the reader implementation.
const RUST_SECTION_BYTES = 1024 * 1024;

const sectionOffset = 19;
const readSection = (
  bytes: Buffer,
  options?: Parameters<typeof readAuditableSectionFromReader>[4],
) =>
  readAuditableSectionFromReader(
    ".dep-v0",
    { offset: sectionOffset, size: bytes.length },
    async (at, length) =>
      bytes.subarray(at - sectionOffset, at - sectionOffset + length),
    async () => {},
    options,
  );

const sectionJson = (document: string) =>
  readSection(deflateSync(Buffer.from(document)));
const section = (document: unknown) => sectionJson(JSON.stringify(document));

it("preserves package order, omitted kind, and the root index", async () => {
  const parsed = await section({
    packages: [
      { name: "itoa", version: "1.0.18", source: "crates.io" },
      {
        name: "sample",
        version: "0.1.0",
        source: "local",
        dependencies: [0],
        root: true,
        kind: "runtime",
      },
    ],
    format: 1,
  });
  expect(parsed).toMatchObject({
    section_name: ".dep-v0",
    file_offset: sectionOffset,
    format_version: 1,
    root_package_index: 1,
    compressed_bytes: parsed.section_bytes,
    packages: [
      {
        name: "itoa",
        version: "1.0.18",
        source: "crates.io",
        kind: null,
        dependencies: [],
        root: false,
      },
      {
        name: "sample",
        version: "0.1.0",
        kind: "runtime",
        dependencies: [0],
        root: true,
      },
    ],
    dependency_edges: [{ from_index: 1, to_index: 0 }],
    cyclic_dependency_indices: [],
  });
  expect(parsed.uncompressed_bytes).toBeGreaterThan(parsed.compressed_bytes);
});

it("preserves historical cargo-auditable feature lists and rejects bad values", async () => {
  const parsed = await section({
    format: 0,
    packages: [
      {
        name: "feature_dep",
        version: "1.2.3",
        source: "crates.io",
        features: ["default", "serde"],
      },
    ],
  });
  expect(parsed.packages).toEqual([
    {
      name: "feature_dep",
      version: "1.2.3",
      source: "crates.io",
      kind: null,
      dependencies: [],
      features: ["default", "serde"],
      root: false,
    },
  ]);
  const omitted = await section({
    packages: [{ name: "no_features", version: "1", source: "crates.io" }],
  });
  const explicitEmpty = await section({
    packages: [
      {
        name: "no_features",
        version: "1",
        source: "crates.io",
        features: [],
      },
    ],
  });
  expect(omitted.packages[0]?.features).toBeNull();
  expect(explicitEmpty.packages[0]?.features).toEqual([]);
  await expect(
    section({
      packages: [
        {
          name: "feature_dep",
          version: "1.2.3",
          source: "crates.io",
          features: ["default", 7],
        },
      ],
    }),
  ).rejects.toThrow(ParseFailureError);
});

it("reports only cyclic packages and preserves omitted root and version", async () => {
  // A multi-package component, a self-cycle, and a leaf reachable from a cycle.
  const parsed = await section({
    packages: [[1, 2, 4], [0], [1], [3], []].map((dependencies, index) => ({
      name: `package-${String(index)}`,
      version: "1",
      source: "local",
      dependencies,
    })),
  });
  expect(parsed.cyclic_dependency_indices).toEqual([0, 1, 2, 3]);
  expect(parsed.format_version).toBeNull();
  expect(parsed.root_package_index).toBeNull();
});

it("finishes a long acyclic dependency chain", async () => {
  const count = 20_000;
  const parsed = await section({
    packages: Array.from({ length: count }, (_, index) => ({
      name: `p${index.toString(36)}`,
      version: "1",
      source: "local",
      ...(index + 1 < count ? { dependencies: [index + 1] } : {}),
    })),
  });
  expect(parsed.packages).toHaveLength(count);
  expect(parsed.cyclic_dependency_indices).toEqual([]);
});

it("rejects out-of-range indices, multiple roots, and schema drift", async () => {
  await expect(
    section({
      packages: [
        { name: "a", version: "1", source: "local", dependencies: [2] },
      ],
    }),
  ).rejects.toThrow(ParseFailureError);
  await expect(
    section({
      packages: [
        { name: "a", version: "1", source: "local", root: true },
        { name: "b", version: "1", source: "local", root: true },
      ],
    }),
  ).rejects.toThrow(/more than one root/);
  await expect(
    section({
      packages: [{ name: "a", version: "1", source: "local" }],
      extra: true,
    }),
  ).rejects.toThrow(/package schema/);
});

it("rejects invalid JSON, trailing zlib bytes, and an empty section", async () => {
  await expect(readSection(deflateSync(Buffer.from("{")))).rejects.toThrow(
    /JSON is invalid/,
  );
  const trailed = Buffer.concat([
    deflateSync(Buffer.from('{"packages":[]}')),
    Buffer.from([0]),
  ]);
  await expect(readSection(trailed)).rejects.toThrow(/zlib stream/);
  await expect(readSection(Buffer.alloc(0))).rejects.toThrow(/empty/);
  await expect(readSection(Buffer.from([1, 2, 3]))).rejects.toThrow(
    ParseFailureError,
  );
});

it("reports the absolute end of a short dependency read", async () => {
  const bytes = deflateSync(Buffer.from('{"packages":[]}'));
  await expect(
    readAuditableSectionFromReader(
      ".dep-v0",
      { offset: sectionOffset, size: bytes.length },
      async (_offset, length) => bytes.subarray(0, length - 1),
      async () => {},
    ),
  ).rejects.toMatchObject({
    failure: {
      kind: "truncated",
      format: "rust-auditable",
      offset: sectionOffset + bytes.length - 1,
    },
  });
});

it("rejects duplicate decoded JSON fields before object conversion", async () => {
  for (const document of [
    '{"packages":[],"packages":[]}',
    '{"packages":[{"name":"alpha","name":"beta","version":"1","source":"local"}]}',
    '{"packages":[{"name":"alpha","version":"1","source":"local","dependencies":[0],"dependencies":[]}]}',
    '{"packages":[],"meta":{"name":"alpha","na\\u006de":"beta"}}',
  ])
    await expect(sectionJson(document)).rejects.toThrow(
      /duplicate field "(?:packages|name|dependencies)"/u,
    );
  expect(
    (
      await sectionJson(
        '{"packages":[{"name":"alpha","version":"1","source":"local"}]}',
      )
    ).packages,
  ).toHaveLength(1);
});

it("stops an inflate that exceeds the section ratio", async () => {
  const raw = Buffer.alloc(8000);
  const compressed = deflateSync(raw);
  expect(compressed.length * 64).toBeLessThan(raw.length);
  await expect(readSection(compressed)).rejects.toThrow(
    expect.objectContaining({
      failure: expect.objectContaining({
        kind: "limit",
        limit: {
          name: "max_dependency_inflate_ratio",
          maximum: 64,
        },
      }),
    }),
  );
  await expect(
    readSection(Buffer.alloc(RUST_SECTION_BYTES + 1)),
  ).rejects.toThrow(
    expect.objectContaining({
      failure: expect.objectContaining({
        kind: "limit",
        limit: {
          name: "max_compressed_dependency_bytes",
          maximum: RUST_SECTION_BYTES,
          required: RUST_SECTION_BYTES + 1,
        },
      }),
    }),
  );
});

it("admits a section above the former compressed and inflated ceilings once those budgets are raised", async () => {
  const name = "n".repeat(8 * 1024 * 1024 + 64);
  const document = JSON.stringify({
    packages: [{ name, version: "1", source: "local", root: true }],
  });
  const compressed = deflateSync(Buffer.from(document), { level: 0 });
  const inflatedBytes = Buffer.byteLength(document);
  expect(compressed.length).toBeGreaterThan(RUST_SECTION_BYTES);
  expect(inflatedBytes).toBeGreaterThan(8 * 1024 * 1024);

  await expect(readSection(compressed)).rejects.toMatchObject({
    failure: {
      kind: "limit",
      limit: {
        name: "max_compressed_dependency_bytes",
        maximum: RUST_SECTION_BYTES,
      },
    },
  });
  await expect(
    readSection(compressed, { compressedBytes: compressed.length }),
  ).rejects.toMatchObject({
    failure: {
      kind: "limit",
      limit: {
        name: "max_inflated_dependency_bytes",
        maximum: 8 * 1024 * 1024,
      },
    },
  });
  const parsed = await readSection(compressed, {
    compressedBytes: compressed.length,
    inflatedBytes,
  });
  expect(parsed.packages[0]?.name).toHaveLength(name.length);
});

it("admits an inflate ratio above 64 after the default ratio refuses it", async () => {
  const name = "n".repeat(8000);
  const document = JSON.stringify({
    packages: [{ name, version: "1", source: "local", root: true }],
  });
  const compressed = deflateSync(Buffer.from(document));
  const inflatedBytes = Buffer.byteLength(document);
  expect(inflatedBytes).toBeGreaterThan(compressed.length * 64);
  await expect(readSection(compressed)).rejects.toMatchObject({
    failure: {
      kind: "limit",
      limit: { name: "max_dependency_inflate_ratio", maximum: 64 },
    },
  });
  const parsed = await readSection(compressed, {
    inflateRatio: Math.ceil(inflatedBytes / compressed.length),
  });
  expect(parsed.packages[0]?.name).toBe(name);
});

it("names the padded-storage basis when a padded section overflows inflate allocation", async () => {
  // A short stream padded to FileAlignment: the stream-based limit is unknown
  // when inflate stops, so the enforced bound comes from the storage size.
  const document = Buffer.concat([
    Buffer.from(JSON.stringify({ packages: [] })),
    Buffer.alloc(40_000, 0x20),
  ]);
  const compressed = deflateSync(document);
  const fileAlignment = 512;
  expect(compressed.length).toBeLessThan(fileAlignment);
  const stored = Buffer.alloc(fileAlignment);
  compressed.copy(stored);
  await expect(
    readSection(stored, {
      peFileAlignment: fileAlignment,
    }),
  ).rejects.toThrow(
    expect.objectContaining({
      failure: expect.objectContaining({
        kind: "limit",
        limit: {
          name: "max_dependency_inflate_ratio",
          maximum: 64,
        },
      }),
      cause: expect.objectContaining({ code: "ERR_BUFFER_TOO_LARGE" }),
    }),
  );
  await expect(readSection(compressed)).rejects.toThrow(
    expect.objectContaining({
      failure: expect.objectContaining({
        kind: "limit",
        limit: expect.objectContaining({
          name: "max_dependency_inflate_ratio",
          maximum: 64,
        }),
      }),
    }),
  );
});

it("names the fixed cap when it bounds a large padded section's inflate allocation", async () => {
  // Storage above 128 KiB derives more than the fixed 8 MiB cap, so the cap,
  // not the padded storage size, is the enforced bound.
  const compressed = deflateSync(Buffer.alloc(9 * 1024 * 1024, 0x20), {
    level: 1,
  });
  const fileAlignment = 512;
  const stored = Buffer.alloc(132 * 1024);
  compressed.copy(stored);
  let failure: unknown;
  try {
    await readSection(stored, {
      peFileAlignment: fileAlignment,
    });
  } catch (cause: unknown) {
    failure = cause;
  }
  expect(failure).toMatchObject({
    failure: expect.objectContaining({
      kind: "limit",
      limit: {
        name: "max_inflated_dependency_bytes",
        maximum: 8 * 1024 * 1024,
      },
    }),
  });
  expect(failure).not.toMatchObject({
    failure: {
      limit: { name: "max_dependency_inflate_ratio" },
    },
  });
});

it.each([0, 4, 8, 0xffff_ffff])(
  "preserves cargo-auditable revision %i through metadata validation",
  async (format) => {
    const parsed = await section({
      format,
      packages: [
        { name: "sample", version: "0.1.0", source: "local", root: true },
      ],
    });
    expect(parsed).toMatchObject({
      format_version: format,
      root_package_index: 0,
    });
    expect(rustAuditableMetadataSchema.parse(parsed)).toEqual(parsed);
  },
);

it("rejects unknown package fields even for a forward-compatible revision", async () => {
  await expect(
    section({
      format: 99,
      packages: [
        { name: "sample", version: "0.1.0", source: "local", future: true },
      ],
    }),
  ).rejects.toThrow(/package schema/);
});

it.each([-1, 1.5, 0x1_0000_0000])(
  "rejects invalid cargo-auditable format value %s",
  async (format) => {
    await expect(section({ format, packages: [] })).rejects.toThrow(
      expect.objectContaining({
        name: "ParseFailureError",
        failure: expect.objectContaining({
          kind: "malformed",
          format: "rust-auditable",
        }),
      }),
    );
  },
);

it("identifies the first malformed package after a valid one", async () => {
  const valid = { name: "valid", version: "1", source: "local" };
  for (const invalid of [{}, { ...valid, dependencies: [null] }]) {
    await expect(section({ packages: [valid, invalid, null] })).rejects.toThrow(
      /Dependency package 1 does not match the package schema/u,
    );
  }
});

it("admits an explicit empty feature list at its exact normalized graph size", async () => {
  const pkg = {
    name: "a",
    version: "1",
    source: "s",
    features: [],
    root: true,
  };
  const expected = { ...pkg, kind: null, dependencies: [] };
  const maxOutputBytes = Buffer.byteLength(JSON.stringify(expected));
  const payload = deflateSync(
    Buffer.from(JSON.stringify({ format: 0, packages: [pkg] })),
  );
  expect((await readSection(payload, { maxOutputBytes })).packages).toEqual([
    expected,
  ]);
  await expect(
    readSection(payload, {
      maxOutputBytes: maxOutputBytes - 1,
    }),
  ).rejects.toThrow(
    expect.objectContaining({
      failure: expect.objectContaining({
        kind: "limit",
        limit: expect.objectContaining({
          name: "dependency graph output bytes",
          maximum: maxOutputBytes - 1,
        }),
      }),
    }),
  );
});
it("admits dependency expansion before allocating normalized or reverse edges", async () => {
  const document = {
    packages: [
      {
        name: "a",
        version: "1",
        source: "local",
        dependencies: Array<number>(400_000).fill(0),
      },
    ],
  };
  // An uncompressed zlib stream clears the ratio guard while remaining below
  // the one-MiB section limit, isolating the graph representation admission.
  const payload = deflateSync(Buffer.from(JSON.stringify(document)), {
    level: 0,
  });
  expect(payload.length).toBeLessThan(RUST_SECTION_BYTES);
  await expect(readSection(payload)).rejects.toThrow(
    expect.objectContaining({
      failure: expect.objectContaining({
        kind: "limit",
        limit: expect.objectContaining({
          name: "dependency graph output bytes",
          maximum: 8 * 1024 * 1024,
        }),
      }),
    }),
  );
});
