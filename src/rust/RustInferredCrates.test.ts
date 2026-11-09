import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import {
  MAX_RUST_FINGERPRINT_SCAN_BYTES,
  rustBinarySchema,
} from "../domain/rust/rustBinary.js";
import { parseExactRustcVersionBanner } from "../domain/rust/rustSourceFingerprints.js";
import type { BinaryContainer } from "../native/metadata/BinaryContainer.js";
import { readBinaryContainer } from "../native/metadata/readBinaryContainer.js";
import {
  createRustImage,
  createUniversalRustMachoImage,
} from "../../tests/fixtures/rust/image.js";
import { RustBinaryProvider } from "./RustBinaryProvider.js";
import {
  recoverRustSourceFingerprints,
  recoverRustSourceFingerprintsAsync,
} from "./RustInferredCrates.js";

it("recovers hyphenated, numeric, pre-release, build-metadata, Windows, and git Cargo crates", () => {
  const rodata = Buffer.from(
    [
      "/cargo/registry/src/index.crates.io-6f17d22bba15001f/tokio-util-0.7.13/src/codec/framed.rs",
      "/home/builder/.cargo/registry/src/index.crates.io-6f17d22bba15001f/futures-channel-0.3.31/src/mpsc/mod.rs",
      "C:\\workspace\\.cargo\\registry\\src\\index.crates.io-6f17d22bba15001f\\x86_64-0.15.2\\src\\instructions\\tables.rs",
      "\\cargo\\registry\\src\\github.com-1ecc6299db9ec823\\rand_chacha-0.3.1\\src\\guts.rs",
      "/cargo/registry/src/index.crates.io-6f17d22bba15001f/serde-1.0.217-alpha.1/src/lib.rs",
      "/cargo/registry/src/index.crates.io-6f17d22bba15001f/zstd-sys-2.0.13+zstd.1.5.6/src/lib.rs",
      "/cargo/registry/src/index.crates.io-6f17d22bba15001f/foo-1-0.2.0/src/lib.rs",
      "/cargo/registry/src/index.crates.io-6f17d22bba15001f/tokio-util-0.7.13/src/sync/cancellation_token.rs",
      "/cargo/git/checkouts/quinn-0123456789abcdef/a1b2c3d/src/lib.rs",
      "C:\\cargo\\git\\checkouts\\quiche.rs-fedcba9876543210\\0123456789abcdef0123456789abcdef01234567\\src\\lib.rs",
      "/cargo/git/checkouts/quinn-0123456789abcdef/a1b2c3d/src/endpoint.rs",
      "notcargo/registry/src/index.crates.io-6f17d22bba15001f/ignored-1.0.0/src/lib.rs",
      "foo.cargo/registry/src/index.crates.io-6f17d22bba15001f/ignored-2.0.0/src/lib.rs",
      "/cargo/registry/src/index.crates.io-6f17d22bba15001f/bad-01.0.0/src/lib.rs",
    ].join("\0") + "\0",
    "latin1",
  );
  const bytes = createRustImage({
    format: "elf",
    omitSection: true,
    readOnlyBytes: rodata,
  });
  const container = readBinaryContainer(bytes);
  const result = recoverRustSourceFingerprints(bytes, container);

  expect(result.inferred_crates).toMatchObject({
    evidence_kind: "inferred",
    discovered_count: 9,
    max_items: 1000,
    truncated: false,
  });
  expect(
    result.inferred_crates.items.map(
      ({ first_file_offset: _offset, ...item }) => item,
    ),
  ).toEqual([
    {
      name: "tokio-util",
      version: "0.7.13",
      source_kind: "registry",
      registry_index: "index.crates.io-6f17d22bba15001f",
      checkout_id: null,
      revision: null,
      reference_count: 2,
    },
    {
      name: "futures-channel",
      version: "0.3.31",
      source_kind: "registry",
      registry_index: "index.crates.io-6f17d22bba15001f",
      checkout_id: null,
      revision: null,
      reference_count: 1,
    },
    {
      name: "x86_64",
      version: "0.15.2",
      source_kind: "registry",
      registry_index: "index.crates.io-6f17d22bba15001f",
      checkout_id: null,
      revision: null,
      reference_count: 1,
    },
    {
      name: "rand_chacha",
      version: "0.3.1",
      source_kind: "registry",
      registry_index: "github.com-1ecc6299db9ec823",
      checkout_id: null,
      revision: null,
      reference_count: 1,
    },
    {
      name: "serde",
      version: "1.0.217-alpha.1",
      source_kind: "registry",
      registry_index: "index.crates.io-6f17d22bba15001f",
      checkout_id: null,
      revision: null,
      reference_count: 1,
    },
    {
      name: "zstd-sys",
      version: "2.0.13+zstd.1.5.6",
      source_kind: "registry",
      registry_index: "index.crates.io-6f17d22bba15001f",
      checkout_id: null,
      revision: null,
      reference_count: 1,
    },
    {
      name: "foo-1",
      version: "0.2.0",
      source_kind: "registry",
      registry_index: "index.crates.io-6f17d22bba15001f",
      checkout_id: null,
      revision: null,
      reference_count: 1,
    },
    {
      name: "quinn",
      version: null,
      source_kind: "git",
      registry_index: null,
      checkout_id: "0123456789abcdef",
      revision: "a1b2c3d",
      reference_count: 2,
    },
    {
      name: "quiche.rs",
      version: null,
      source_kind: "git",
      registry_index: null,
      checkout_id: "fedcba9876543210",
      revision: "0123456789abcdef0123456789abcdef01234567",
      reference_count: 1,
    },
  ]);
});

it("recovers deduplicated rustc version banners from read-only sections and ELF .comment", () => {
  const rodata = Buffer.from(
    "built with rustc 1.85.0 (4d91de4e4 2025-02-17) and rustc 1.84.0-beta.2!\0",
    "latin1",
  );
  const comment = Buffer.from(
    "\0GCC: (Ubuntu 13.3.0) 13.3.0\0rustc version 1.86.0-nightly (a1b2c3d4e 2025-01-10)\0rustc version 1.86.0-nightly (a1b2c3d4e 2025-01-10)\0",
    "latin1",
  );
  const bytes = createRustImage({
    format: "elf",
    omitSection: true,
    readOnlyBytes: rodata,
    elfComment: comment,
  });
  const container = readBinaryContainer(bytes);
  const result = recoverRustSourceFingerprints(bytes, container);

  expect(result.rustc_versions).toEqual({
    evidence_kind: "inferred",
    discovered_count: 3,
    truncated: false,
    items: [
      {
        banner: "rustc 1.85.0 (4d91de4e4 2025-02-17)",
        version: "1.85.0",
        channel: "stable",
        commit_hash: "4d91de4e4",
        commit_date: "2025-02-17",
        first_file_offset: expect.any(Number) as number,
        reference_count: 1,
      },
      {
        banner: "rustc 1.84.0-beta.2",
        version: "1.84.0-beta.2",
        channel: "beta",
        commit_hash: null,
        commit_date: null,
        first_file_offset: expect.any(Number) as number,
        reference_count: 1,
      },
      {
        banner: "rustc version 1.86.0-nightly (a1b2c3d4e 2025-01-10)",
        version: "1.86.0-nightly",
        channel: "nightly",
        commit_hash: "a1b2c3d4e",
        commit_date: "2025-01-10",
        first_file_offset: expect.any(Number) as number,
        reference_count: 2,
      },
    ],
  });
});

it.each([
  ["writable", 1, 1n, false],
  ["executable", 1, 4n, false],
  ["compressed", 1, 0x30n, true],
  ["nobits", 8, 0x30n, false],
] as const)(
  "ignores unsafe ELF .comment sections (%s)",
  (_label, type, flags, compressed) => {
    const payload = Buffer.from(
      "\0rustc version 1.85.0 (4d91de4e4 2025-02-17)\0",
      "latin1",
    );
    const bytes = Buffer.alloc(512);
    payload.copy(bytes, 128);
    const container: BinaryContainer = {
      format: "elf",
      elf: { machine: 62, type: 2, dynamicSegments: [] },
      architecture: "amd64",
      bits: 64,
      byte_order: "little",
      mappings: [],
      zero_fills: [],
      sections: [
        {
          format: "elf",
          name: ".comment",
          offset: 128,
          size: payload.length,
          type,
          flags,
          address: 0n,
          declared_range: { offset: 128n, size: BigInt(payload.length) },
          compressed,
          read_only: false,
          file_backed: type !== 8,
        },
      ],
      load_regions: [],
    };
    const result = recoverRustSourceFingerprints(bytes, container);
    expect(result.rustc_versions.items).toEqual([]);
  },
);

it("recovers tokens straddling the 1 MiB scan window boundary without double-counting overlapping mappings", () => {
  const windowBoundary = 1024 * 1024;
  const bytes = Buffer.alloc(windowBoundary + 512);
  // Place "cargo" so 'c','a' sit before 1 MiB and 'r','g','o' sit at/after 1 MiB.
  const cargoStart = windowBoundary - 2;
  bytes.write(
    "cargo/registry/src/index.crates.io-6f17d22bba15001f/tokio-1.43.0/src/lib.rs\0",
    cargoStart,
    "latin1",
  );
  const rustcStart = windowBoundary + 128;
  bytes.write("rustc 1.85.0-dev\0", rustcStart, "latin1");

  const container: BinaryContainer = {
    format: "elf",
    elf: { machine: 62, type: 2, dynamicSegments: [] },
    architecture: "amd64",
    bits: 64,
    byte_order: "little",
    mappings: [{ address: 0x400000n, offset: 0, size: bytes.length }],
    zero_fills: [],
    sections: [
      {
        format: "elf",
        name: ".rodata",
        offset: 0,
        size: bytes.length,
        type: 1,
        flags: 2n,
        address: 0x400000n,
        declared_range: { offset: 0n, size: BigInt(bytes.length) },
        compressed: false,
        read_only: true,
        file_backed: true,
      },
    ],
    load_regions: [
      {
        mapping: { address: 0x400000n, offset: 0, size: bytes.length },
        memory_size: BigInt(bytes.length),
        read: true,
        write: false,
        execute: false,
      },
    ],
  };

  const result = recoverRustSourceFingerprints(bytes, container);
  expect(result.inferred_crates.items).toEqual([
    {
      name: "tokio",
      version: "1.43.0",
      source_kind: "registry",
      registry_index: "index.crates.io-6f17d22bba15001f",
      checkout_id: null,
      revision: null,
      first_file_offset: cargoStart,
      reference_count: 1,
    },
  ]);
  expect(result.rustc_versions.items).toEqual([
    {
      banner: "rustc 1.85.0-dev",
      version: "1.85.0-dev",
      channel: "dev",
      commit_hash: null,
      commit_date: null,
      first_file_offset: rustcStart,
      reference_count: 1,
    },
  ]);
});

it("enforces max_inferred_crates, 64-banner rustc_versions cap, 64 MiB scan budget, and cooperative cancellation", () => {
  const lines: string[] = [];
  for (let index = 0; index < 5; index += 1) {
    lines.push(
      `/cargo/registry/src/index.crates.io-6f17d22bba15001f/crate_${String(index)}-1.0.${String(index)}/src/lib.rs`,
    );
  }
  lines.push(
    "/cargo/registry/src/index.crates.io-6f17d22bba15001f/crate_0-1.0.0/src/other.rs",
  );
  for (let index = 0; index < 66; index += 1) {
    lines.push(`rustc 1.${String(index)}.0`);
  }
  const text = Buffer.from(lines.join("\0") + "\0", "latin1");
  const container: BinaryContainer = {
    format: "pe",
    architecture: "amd64",
    bits: 64,
    byte_order: "little",
    mappings: [],
    zero_fills: [],
    sections: [
      {
        format: "pe",
        name: ".rdata",
        offset: 0,
        size: text.length,
        virtual_address: 0x1000,
        virtual_size: text.length,
        raw_size: text.length,
        file_alignment: 512,
        characteristics: 0x40000040,
        compressed: false,
        read_only: true,
        file_backed: true,
      },
    ],
  };

  const capped = recoverRustSourceFingerprints(text, container, 2);
  expect(capped.inferred_crates).toMatchObject({
    discovered_count: 5,
    max_items: 2,
    truncated: true,
    items: [
      expect.objectContaining({ name: "crate_0", reference_count: 2 }),
      expect.objectContaining({ name: "crate_1", reference_count: 1 }),
    ],
  });
  expect(capped.rustc_versions).toMatchObject({
    discovered_count: 66,
    truncated: true,
  });
  expect(capped.rustc_versions.items).toHaveLength(64);

  const overBudgetBytes = Buffer.alloc(MAX_RUST_FINGERPRINT_SCAN_BYTES + 256);
  overBudgetBytes.write(
    "/cargo/registry/src/index.crates.io-6f17d22bba15001f/early-1.0.0/src/lib.rs\0",
    0,
    "latin1",
  );
  overBudgetBytes.write(
    "/cargo/registry/src/index.crates.io-6f17d22bba15001f/beyond_budget-1.0.0/src/lib.rs\0",
    MAX_RUST_FINGERPRINT_SCAN_BYTES + 16,
    "latin1",
  );
  const overBudgetContainer: BinaryContainer = {
    format: "pe",
    architecture: "amd64",
    bits: 64,
    byte_order: "little",
    mappings: [],
    zero_fills: [],
    sections: [
      {
        format: "pe",
        name: ".rdata",
        offset: 0,
        size: overBudgetBytes.length,
        virtual_address: 0x1000,
        virtual_size: overBudgetBytes.length,
        raw_size: overBudgetBytes.length,
        file_alignment: 512,
        characteristics: 0x40000040,
        compressed: false,
        read_only: true,
        file_backed: true,
      },
    ],
  };
  const budgetResult = recoverRustSourceFingerprints(
    overBudgetBytes,
    overBudgetContainer,
  );
  expect(budgetResult.inferred_crates).toMatchObject({
    discovered_count: 1,
    truncated: true,
    items: [expect.objectContaining({ name: "early" })],
  });
  expect(budgetResult.rustc_versions.truncated).toBe(true);

  let checks = 0;
  expect(() =>
    recoverRustSourceFingerprints(
      overBudgetBytes,
      overBudgetContainer,
      1000,
      () => {
        checks += 1;
        if (checks >= 3) throw new Error("scan cancelled");
      },
    ),
  ).toThrow("scan cancelled");
});

it("enforces universal Mach-O slice range containment and parity on rustBinarySchema", () => {
  const base = {
    artifact: {
      path: "/artifacts/universal",
      sha256: "a".repeat(64),
      bytes: 8192,
    },
    format: "macho" as const,
    architecture: "arm64",
    bits: 64 as const,
    byte_order: "little" as const,
    selected_slice: {
      kind: "macho-selected-image-v1" as const,
      container: "fat" as const,
      offset: 4096,
      byte_length: 4096,
      cpu_type: 0x0100000c,
      cpu_subtype: 0,
      container_table_sha256: "b".repeat(64),
    },
    auditable_metadata: null,
    rustc_commit: null,
    inferred_crates: {
      evidence_kind: "inferred" as const,
      items: [
        {
          name: "tokio",
          version: "1.43.0",
          source_kind: "registry" as const,
          registry_index: "index.crates.io-6f17d22bba15001f",
          checkout_id: null,
          revision: null,
          first_file_offset: 4200,
          reference_count: 1,
        },
      ],
      discovered_count: 1,
      max_items: 1000,
      truncated: false,
    },
    rustc_versions: {
      evidence_kind: "inferred" as const,
      items: [
        {
          banner: "rustc 1.85.0 (4d91de4e4 2025-02-17)",
          version: "1.85.0",
          channel: "stable" as const,
          commit_hash: "4d91de4e4",
          commit_date: "2025-02-17",
          first_file_offset: 4400,
          reference_count: 1,
        },
      ],
      discovered_count: 1,
      truncated: false,
    },
    limitations: [],
  };

  expect(rustBinarySchema.safeParse(base).success).toBe(true);

  const outsideSlice = structuredClone(base);
  outsideSlice.inferred_crates.items[0]!.first_file_offset = 512;
  expect(rustBinarySchema.safeParse(outsideSlice).success).toBe(false);

  const missingVersions = { ...base, rustc_versions: undefined };
  expect(rustBinarySchema.safeParse(missingVersions).success).toBe(false);
});

it("rebases universal Mach-O slice offsets and preserves default parity in RustBinaryProvider", async () => {
  const dir = await createTestTempDirectory("rea-rust-provider-slice-");
  const provider = new RustBinaryProvider();
  try {
    const universalPath = join(dir, "universal.macho");
    await writeFile(
      universalPath,
      createUniversalRustMachoImage({
        x86_64ReadOnly: Buffer.from(
          "/cargo/registry/src/index.crates.io-6f17d22bba15001f/x86_only-1.0.0/src/lib.rs\0",
          "latin1",
        ),
        arm64ReadOnly: Buffer.from(
          "/cargo/registry/src/index.crates.io-6f17d22bba15001f/tokio-util-0.7.13/src/lib.rs\0rustc 1.85.0 (4d91de4e4 2025-02-17)\0",
          "latin1",
        ),
      }),
    );

    const defaultRes = await provider.inspect({
      path: universalPath,
      architecture: "arm64",
    });
    if (!defaultRes.ok) throw defaultRes.error;
    expect(defaultRes.value).not.toHaveProperty("inferred_crates");
    expect(defaultRes.value).not.toHaveProperty("rustc_versions");

    const optedRes = await provider.inspect({
      path: universalPath,
      architecture: "arm64",
      include_inferred_crates: true,
    });
    if (!optedRes.ok) throw optedRes.error;
    expect(optedRes.value.selected_slice).toMatchObject({
      kind: "macho-selected-image-v1",
      container: "fat",
      offset: 8192,
      byte_length: 4096,
      cpu_type: 0x0100000c,
    });
    expect(optedRes.value.inferred_crates?.items).toEqual([
      {
        name: "tokio-util",
        version: "0.7.13",
        source_kind: "registry",
        registry_index: "index.crates.io-6f17d22bba15001f",
        checkout_id: null,
        revision: null,
        first_file_offset: 8192 + 2049,
        reference_count: 1,
      },
    ]);
    expect(
      optedRes.value.rustc_versions?.items[0]?.first_file_offset,
    ).toBeGreaterThan(8192 + 2048);
  } finally {
    await provider.close();
  }
});

it("retains git checkout_id and Cargo URL path-segment punctuation while rejecting dot-only or delimiter slugs", () => {
  const bytes = createRustImage({
    format: "elf",
    omitSection: true,
    readOnlyBytes: Buffer.from(
      [
        "/cargo/git/checkouts/foo-1111111111111111/abcdef1/src/lib.rs",
        "/cargo/git/checkouts/foo-2222222222222222/abcdef1/src/lib.rs",
        "/cargo/git/checkouts/foo-1111111111111111/abcdef1/src/other.rs",
        "/cargo/git/checkouts/.dot-repo-0123456789abcdef/a1b2c3d/src/lib.rs",
        "/cargo/git/checkouts/-dash+repo-fedcba9876543210/a1b2c3d/src/lib.rs",
        "/cargo/git/checkouts/repo@v1-3333333333333333/a1b2c3d/src/lib.rs",
        "/cargo/git/checkouts/repo!$&'()*,:;=[]^|%20~-4444444444444444/a1b2c3d/src/lib.rs",
        "/cargo/git/checkouts/.-0123456789abcdef/a1b2c3d/src/lib.rs",
        "/cargo/git/checkouts/..-0123456789abcdef/a1b2c3d/src/lib.rs",
        "/cargo/git/checkouts/bad?query-0123456789abcdef/a1b2c3d/src/lib.rs",
        "/cargo/git/checkouts/bad#frag-0123456789abcdef/a1b2c3d/src/lib.rs",
      ].join("\0") + "\0",
      "latin1",
    ),
  });
  const result = recoverRustSourceFingerprints(
    bytes,
    readBinaryContainer(bytes),
  );
  expect(result.inferred_crates.discovered_count).toBe(6);
  expect(
    result.inferred_crates.items.map(
      ({ first_file_offset: _offset, ...item }) => item,
    ),
  ).toEqual([
    {
      name: "foo",
      version: null,
      source_kind: "git",
      registry_index: null,
      checkout_id: "1111111111111111",
      revision: "abcdef1",
      reference_count: 2,
    },
    {
      name: "foo",
      version: null,
      source_kind: "git",
      registry_index: null,
      checkout_id: "2222222222222222",
      revision: "abcdef1",
      reference_count: 1,
    },
    {
      name: ".dot-repo",
      version: null,
      source_kind: "git",
      registry_index: null,
      checkout_id: "0123456789abcdef",
      revision: "a1b2c3d",
      reference_count: 1,
    },
    {
      name: "-dash+repo",
      version: null,
      source_kind: "git",
      registry_index: null,
      checkout_id: "fedcba9876543210",
      revision: "a1b2c3d",
      reference_count: 1,
    },
    {
      name: "repo@v1",
      version: null,
      source_kind: "git",
      registry_index: null,
      checkout_id: "3333333333333333",
      revision: "a1b2c3d",
      reference_count: 1,
    },
    {
      name: "repo!$&'()*,:;=[]^|%20~",
      version: null,
      source_kind: "git",
      registry_index: null,
      checkout_id: "4444444444444444",
      revision: "a1b2c3d",
      reference_count: 1,
    },
  ]);

  const validReport = {
    artifact: { path: "/artifacts/git", sha256: "a".repeat(64), bytes: 8192 },
    format: "elf" as const,
    architecture: "amd64",
    bits: 64 as const,
    byte_order: "little" as const,
    auditable_metadata: null,
    rustc_commit: null,
    inferred_crates: result.inferred_crates,
    rustc_versions: result.rustc_versions,
    limitations: [],
  };
  expect(rustBinarySchema.safeParse(validReport).success).toBe(true);

  const duplicateCheckout = structuredClone(validReport);
  duplicateCheckout.inferred_crates.items[1]!.checkout_id = "1111111111111111";
  expect(rustBinarySchema.safeParse(duplicateCheckout).success).toBe(false);

  const missingCheckout = structuredClone(validReport);
  missingCheckout.inferred_crates.items[0]!.checkout_id = null;
  expect(rustBinarySchema.safeParse(missingCheckout).success).toBe(false);

  const invalidSlugReport = structuredClone(validReport);
  invalidSlugReport.inferred_crates.items[0]!.name = "bad?slug";
  expect(rustBinarySchema.safeParse(invalidSlugReport).success).toBe(false);
});

it("enforces Cargo u64::MAX bounds on SemVer major, minor, and patch components", () => {
  const bytes = createRustImage({
    format: "elf",
    omitSection: true,
    readOnlyBytes: Buffer.from(
      [
        "/cargo/registry/src/index.crates.io-6f17d22bba15001f/max_major-18446744073709551615.0.0/src/lib.rs",
        "/cargo/registry/src/index.crates.io-6f17d22bba15001f/max_patch-0.0.18446744073709551615/src/lib.rs",
        "/cargo/registry/src/index.crates.io-6f17d22bba15001f/over_major-18446744073709551616.0.0/src/lib.rs",
        "/cargo/registry/src/index.crates.io-6f17d22bba15001f/over_minor-0.18446744073709551616.0/src/lib.rs",
        "/cargo/registry/src/index.crates.io-6f17d22bba15001f/over_patch-0.0.18446744073709551616/src/lib.rs",
        "/cargo/registry/src/index.crates.io-6f17d22bba15001f/over_high-20000000000000000000.0.0/src/lib.rs",
        "rustc 18446744073709551615.0.0",
        "rustc 18446744073709551616.0.0",
      ].join("\0") + "\0",
      "latin1",
    ),
  });
  const result = recoverRustSourceFingerprints(
    bytes,
    readBinaryContainer(bytes),
  );
  expect(
    result.inferred_crates.items.map(({ name, version }) => ({
      name,
      version,
    })),
  ).toEqual([
    { name: "max_major", version: "18446744073709551615.0.0" },
    { name: "max_patch", version: "0.0.18446744073709551615" },
  ]);
  expect(result.rustc_versions.items.map((item) => item.version)).toEqual([
    "18446744073709551615.0.0",
  ]);

  const validReport = {
    artifact: { path: "/artifacts/u64", sha256: "a".repeat(64), bytes: 8192 },
    format: "elf" as const,
    architecture: "amd64",
    bits: 64 as const,
    byte_order: "little" as const,
    auditable_metadata: null,
    rustc_commit: null,
    inferred_crates: result.inferred_crates,
    rustc_versions: result.rustc_versions,
    limitations: [],
  };
  expect(rustBinarySchema.safeParse(validReport).success).toBe(true);

  for (const invalidVersion of [
    "18446744073709551616.0.0",
    "0.18446744073709551616.0",
    "0.0.18446744073709551616",
  ]) {
    const invalidReport = structuredClone(validReport);
    invalidReport.inferred_crates.items[0]!.version = invalidVersion;
    expect(rustBinarySchema.safeParse(invalidReport).success).toBe(false);
  }
});

it("rejects numeric prerelease leading zeros while preserving build metadata and alphanumeric prereleases", () => {
  const bytes = createRustImage({
    format: "elf",
    omitSection: true,
    readOnlyBytes: Buffer.from(
      [
        "/cargo/registry/src/index.crates.io-6f17d22bba15001f/bad_num-1.2.3-01/src/lib.rs",
        "/cargo/registry/src/index.crates.io-6f17d22bba15001f/bad_second-1.0.0-alpha.01/src/lib.rs",
        "/cargo/registry/src/index.crates.io-6f17d22bba15001f/good_build-1.0.0+01/src/lib.rs",
        "/cargo/registry/src/index.crates.io-6f17d22bba15001f/good_alnum-1.0.0-01a/src/lib.rs",
        "/cargo/registry/src/index.crates.io-6f17d22bba15001f/good_zero-1.0.0-0/src/lib.rs",
      ].join("\0") + "\0",
      "latin1",
    ),
  });
  const result = recoverRustSourceFingerprints(
    bytes,
    readBinaryContainer(bytes),
  );
  expect(
    result.inferred_crates.items.map(({ name, version }) => ({
      name,
      version,
    })),
  ).toEqual([
    { name: "good_build", version: "1.0.0+01" },
    { name: "good_alnum", version: "1.0.0-01a" },
    { name: "good_zero", version: "1.0.0-0" },
  ]);
});

it("rejects overlong rustc channel banners without emitting invalid prefixes", () => {
  const dotAtLimit = `rustc 1.85.0-nightly.${"a".repeat(80)}.bcdef`;
  const dotJustAfterLimit = `rustc 1.85.0-nightly.${"a".repeat(81)}.bcdef`;
  const overlongAlnum = `rustc 1.85.0-nightly.${"a".repeat(95)}`;
  const validNightly = "rustc 1.85.0-nightly.2025.02.17";
  const bytes = createRustImage({
    format: "elf",
    omitSection: true,
    readOnlyBytes: Buffer.from(
      [dotAtLimit, dotJustAfterLimit, overlongAlnum, validNightly].join("\0") +
        "\0",
      "latin1",
    ),
  });
  const result = recoverRustSourceFingerprints(
    bytes,
    readBinaryContainer(bytes),
  );
  expect(result.rustc_versions.items.map((item) => item.banner)).toEqual([
    validNightly,
  ]);
  for (const item of result.rustc_versions.items) {
    expect(parseExactRustcVersionBanner(item.banner)).not.toBeNull();
  }
});

const createPeReadOnlyContainer = (size: number): BinaryContainer => ({
  format: "pe",
  architecture: "amd64",
  bits: 64,
  byte_order: "little",
  mappings: [],
  zero_fills: [],
  sections: [
    {
      format: "pe",
      name: ".rdata",
      offset: 0,
      size,
      virtual_address: 0x1000,
      virtual_size: size,
      raw_size: size,
      file_alignment: 512,
      characteristics: 0x40000040,
      compressed: false,
      read_only: true,
      file_backed: true,
    },
  ],
});

it("omits incomplete rustc banners truncated at the 64 MiB scan budget boundary", () => {
  for (const [banner, offsetBeforeBudget] of [
    ["rustc 1.85.10\0", "rustc 1.85.1".length],
    ["rustc 1.85.10 (4d91de4e4 2025-02-17)\0", "rustc 1.85.10 (4d91de4".length],
  ] as const) {
    const bytes = Buffer.alloc(MAX_RUST_FINGERPRINT_SCAN_BYTES + 128);
    bytes.write(
      banner,
      MAX_RUST_FINGERPRINT_SCAN_BYTES - offsetBeforeBudget,
      "latin1",
    );
    const result = recoverRustSourceFingerprints(
      bytes,
      createPeReadOnlyContainer(bytes.length),
    );
    expect(result.rustc_versions.truncated).toBe(true);
    expect(result.rustc_versions.items).toEqual([]);
  }
});

it("yields between scan windows so queued event-loop AbortSignal callbacks cancel mid-scan", async () => {
  const bytes = Buffer.alloc(8 * 1024 * 1024);
  const container = createPeReadOnlyContainer(bytes.length);
  const controller = new AbortController();
  let activeChecks = 0;
  const pending = recoverRustSourceFingerprintsAsync(
    bytes,
    container,
    1000,
    () => {
      activeChecks += 1;
      if (controller.signal.aborted) {
        throw new Error(String(controller.signal.reason));
      }
    },
  );
  setImmediate(() => {
    controller.abort("queued event-loop cancellation");
  });
  await expect(pending).rejects.toThrow("queued event-loop cancellation");
  expect(activeChecks).toBeGreaterThanOrEqual(3);
  expect(activeChecks).toBeLessThan(12);
});

it("recovers Cargo Git checkout slugs longer than 128 bytes and marks over-cap checkouts truncated", () => {
  const readOnlyElfContainer = (buf: Buffer): BinaryContainer => ({
    format: "elf",
    elf: { machine: 62, type: 2, dynamicSegments: [] },
    architecture: "amd64",
    bits: 64,
    byte_order: "little",
    mappings: [{ address: 0x400000n, offset: 0, size: buf.length }],
    zero_fills: [],
    sections: [
      {
        format: "elf",
        name: ".rodata",
        offset: 0,
        size: buf.length,
        type: 1,
        flags: 2n,
        address: 0x400000n,
        declared_range: { offset: 0n, size: BigInt(buf.length) },
        compressed: false,
        read_only: true,
        file_backed: true,
      },
    ],
    load_regions: [
      {
        mapping: { address: 0x400000n, offset: 0, size: buf.length },
        memory_size: BigInt(buf.length),
        read: true,
        write: false,
        execute: false,
      },
    ],
  });
  const slug150 = "r".repeat(150);
  const slug1024 = "s".repeat(1024);
  const bytes = Buffer.from(
    [
      `/cargo/git/checkouts/${slug150}-0123456789abcdef/a1b2c3d/src/lib.rs`,
      `/cargo/git/checkouts/${slug1024}-fedcba9876543210/0123456789abcdef/src/lib.rs`,
      `/cargo/git/checkouts/${"x".repeat(1200)}/not_a_checkout`,
    ].join("\0") + "\0",
    "latin1",
  );
  const recovered = recoverRustSourceFingerprints(
    bytes,
    readOnlyElfContainer(bytes),
  );
  expect(recovered.inferred_crates.truncated).toBe(false);
  expect(recovered.inferred_crates.discovered_count).toBe(2);
  expect(
    recovered.inferred_crates.items.map(({ name, checkout_id }) => ({
      name,
      checkout_id,
    })),
  ).toEqual([
    { name: slug150, checkout_id: "0123456789abcdef" },
    { name: slug1024, checkout_id: "fedcba9876543210" },
  ]);
  expect(
    rustBinarySchema.safeParse({
      artifact: {
        path: "/artifacts/long-git",
        sha256: "a".repeat(64),
        bytes: bytes.length,
      },
      format: "elf",
      architecture: "amd64",
      bits: 64,
      byte_order: "little",
      auditable_metadata: null,
      rustc_commit: null,
      inferred_crates: recovered.inferred_crates,
      rustc_versions: recovered.rustc_versions,
      limitations: [],
    }).success,
  ).toBe(true);

  const overCapSlug = "z".repeat(1100);
  const overCapBytes = Buffer.from(
    `/cargo/git/checkouts/${overCapSlug}-0123456789abcdef/a1b2c3d/src/lib.rs\0`,
    "latin1",
  );
  const overCapResult = recoverRustSourceFingerprints(
    overCapBytes,
    readOnlyElfContainer(overCapBytes),
  );
  expect(overCapResult.inferred_crates.items).toEqual([]);
  expect(overCapResult.inferred_crates.discovered_count).toBe(0);
  expect(overCapResult.inferred_crates.truncated).toBe(true);
});

it("recovers IPv6-hosted Cargo registry crates and rejects malformed registry host components", () => {
  const bytes = createRustImage({
    format: "elf",
    omitSection: true,
    readOnlyBytes: Buffer.from(
      [
        "/cargo/registry/src/[::1]-1ecc6299db9ec823/v6dep-0.1.0/src/lib.rs",
        "/cargo/registry/src/[2001:db8::1]-6f17d22bba15001f/full_v6-1.2.3/src/lib.rs",
        "C:\\cargo\\registry\\src\\[::ffff:127.0.0.1]-fedcba9876543210\\mapped_v6-0.4.0\\src\\lib.rs",
        "/cargo/registry/src/127.0.0.1-1ecc6299db9ec823/v4dep-0.1.0/src/lib.rs",
        "/cargo/registry/src/[]-1ecc6299db9ec823/bad_empty-0.1.0/src/lib.rs",
        "/cargo/registry/src/[::1-1ecc6299db9ec823/bad_open-0.1.0/src/lib.rs",
        "/cargo/registry/src/::1]-1ecc6299db9ec823/bad_close-0.1.0/src/lib.rs",
        "/cargo/registry/src/[not-ipv6]-1ecc6299db9ec823/bad_host-0.1.0/src/lib.rs",
        "/cargo/registry/src/[::1]:8080-1ecc6299db9ec823/bad_port-0.1.0/src/lib.rs",
        "/cargo/registry/src/127.0.0.1:8080-1ecc6299db9ec823/bad_v4_port-0.1.0/src/lib.rs",
        "/cargo/registry/src/[1:2:3:4:5:6:7::8]-1ecc6299db9ec823/bad_groups-0.1.0/src/lib.rs",
        "/cargo/registry/src/.-1ecc6299db9ec823/bad_dot-0.1.0/src/lib.rs",
      ].join("\0") + "\0",
      "latin1",
    ),
  });
  const result = recoverRustSourceFingerprints(
    bytes,
    readBinaryContainer(bytes),
  );
  expect(result.inferred_crates.truncated).toBe(false);
  expect(
    result.inferred_crates.items.map(({ name, version, registry_index }) => ({
      name,
      version,
      registry_index,
    })),
  ).toEqual([
    {
      name: "v6dep",
      version: "0.1.0",
      registry_index: "[::1]-1ecc6299db9ec823",
    },
    {
      name: "full_v6",
      version: "1.2.3",
      registry_index: "[2001:db8::1]-6f17d22bba15001f",
    },
    {
      name: "mapped_v6",
      version: "0.4.0",
      registry_index: "[::ffff:127.0.0.1]-fedcba9876543210",
    },
    {
      name: "v4dep",
      version: "0.1.0",
      registry_index: "127.0.0.1-1ecc6299db9ec823",
    },
  ]);

  const validReport = {
    artifact: { path: "/artifacts/ipv6", sha256: "a".repeat(64), bytes: 8192 },
    format: "elf" as const,
    architecture: "amd64",
    bits: 64 as const,
    byte_order: "little" as const,
    auditable_metadata: null,
    rustc_commit: null,
    inferred_crates: result.inferred_crates,
    rustc_versions: result.rustc_versions,
    limitations: [],
  };
  expect(rustBinarySchema.safeParse(validReport).success).toBe(true);

  for (const invalidIndex of [
    "[]-1ecc6299db9ec823",
    "[::1-1ecc6299db9ec823",
    "::1]-1ecc6299db9ec823",
    "[not-ipv6]-1ecc6299db9ec823",
    "[::1]:8080-1ecc6299db9ec823",
    "127.0.0.1:8080-1ecc6299db9ec823",
    "[1:2:3:4:5:6:7::8]-1ecc6299db9ec823",
    ".-1ecc6299db9ec823",
  ]) {
    const invalidReport = structuredClone(validReport);
    invalidReport.inferred_crates.items[0]!.registry_index = invalidIndex;
    expect(rustBinarySchema.safeParse(invalidReport).success).toBe(false);
  }
});

it("recovers Cargo-valid Unicode registry crate names and enforces UTF-8 byte bounds and validity", () => {
  const exact256Utf8Name = "é".repeat(128);
  const rodata = Buffer.concat([
    Buffer.from(
      [
        "/cargo/registry/src/private.example-1ecc6299db9ec823/ascii_dep-0.1.0/src/lib.rs",
        "/cargo/registry/src/private.example-1ecc6299db9ec823/unicodé-0.2.0/src/lib.rs",
        "/cargo/registry/src/private.example-1ecc6299db9ec823/αβγ-delta-1.0.0-alpha.1/src/lib.rs",
        "/cargo/registry/src/private.example-1ecc6299db9ec823/漢字_crate-2.3.4/src/lib.rs",
        `/cargo/registry/src/private.example-1ecc6299db9ec823/${exact256Utf8Name}-1.0.0/src/lib.rs`,
        "/cargo/registry/src/private.example-1ecc6299db9ec823/emoji😀-0.1.0/src/lib.rs",
        "/cargo/registry/src/private.example-1ecc6299db9ec823/\u00b7bad_start-0.1.0/src/lib.rs",
      ].join("\0") + "\0",
      "utf8",
    ),
    Buffer.from(
      "/cargo/registry/src/private.example-1ecc6299db9ec823/bad",
      "ascii",
    ),
    Buffer.from([0xc3]),
    Buffer.from("-0.1.0/src/lib.rs\0", "ascii"),
  ]);
  const bytes = createRustImage({
    format: "elf",
    omitSection: true,
    readOnlyBytes: rodata,
  });
  const result = recoverRustSourceFingerprints(
    bytes,
    readBinaryContainer(bytes),
  );
  expect(result.inferred_crates.truncated).toBe(false);
  expect(result.inferred_crates.discovered_count).toBe(5);
  expect(
    result.inferred_crates.items.map(({ name, version }) => ({
      name,
      version,
    })),
  ).toEqual([
    { name: "ascii_dep", version: "0.1.0" },
    { name: "unicodé", version: "0.2.0" },
    { name: "αβγ-delta", version: "1.0.0-alpha.1" },
    { name: "漢字_crate", version: "2.3.4" },
    { name: exact256Utf8Name, version: "1.0.0" },
  ]);

  const validReport = {
    artifact: {
      path: "/artifacts/unicode",
      sha256: "a".repeat(64),
      bytes: bytes.length,
    },
    format: "elf" as const,
    architecture: "amd64",
    bits: 64 as const,
    byte_order: "little" as const,
    auditable_metadata: null,
    rustc_commit: null,
    inferred_crates: result.inferred_crates,
    rustc_versions: result.rustc_versions,
    limitations: [],
  };
  expect(rustBinarySchema.safeParse(validReport).success).toBe(true);

  // Retained-report offset check must measure UTF-8 bytes ("漢字_crate" = 12 bytes, not 8 UTF-16 units).
  const kanjiItem = structuredClone(result.inferred_crates.items[3]!);
  const minKanjiSpan =
    22 + kanjiItem.registry_index!.length + 12 + kanjiItem.version!.length;
  kanjiItem.first_file_offset = 100;
  const tightValid = {
    ...validReport,
    artifact: { ...validReport.artifact, bytes: 100 + minKanjiSpan },
    inferred_crates: {
      ...result.inferred_crates,
      items: [kanjiItem],
      discovered_count: 1,
    },
  };
  expect(rustBinarySchema.safeParse(tightValid).success).toBe(true);
  expect(
    rustBinarySchema.safeParse({
      ...tightValid,
      artifact: { ...validReport.artifact, bytes: 100 + minKanjiSpan - 1 },
    }).success,
  ).toBe(false);

  for (const invalidName of ["é".repeat(129), "emoji😀", "bad\ud800"]) {
    const bad = structuredClone(tightValid);
    bad.artifact.bytes = 4096;
    bad.inferred_crates.items[0]!.name = invalidName;
    expect(rustBinarySchema.safeParse(bad).success).toBe(false);
  }

  const overCapBytes = createRustImage({
    format: "elf",
    omitSection: true,
    readOnlyBytes: Buffer.from(
      `/cargo/registry/src/private.example-1ecc6299db9ec823/${"é".repeat(129)}-0.1.0/src/lib.rs\0`,
      "utf8",
    ),
  });
  const overCapResult = recoverRustSourceFingerprints(
    overCapBytes,
    readBinaryContainer(overCapBytes),
  );
  expect(overCapResult.inferred_crates.items).toEqual([]);
  expect(overCapResult.inferred_crates.discovered_count).toBe(0);
  expect(overCapResult.inferred_crates.truncated).toBe(true);
});

it("rejects digit-prefixed registry crate names in scanner and retained-report schema while preserving underscore and trailing-digit names", () => {
  const bytes = createRustImage({
    format: "elf",
    omitSection: true,
    readOnlyBytes: Buffer.from(
      [
        "/cargo/registry/src/index.crates.io-6f17d22bba15001f/123foo-0.1.0/src/lib.rs",
        `/cargo/registry/src/index.crates.io-6f17d22bba15001f/9${"a".repeat(260)}-0.1.0/src/lib.rs`,
        "/cargo/registry/src/index.crates.io-6f17d22bba15001f/_123foo-0.1.0/src/lib.rs",
        "/cargo/registry/src/index.crates.io-6f17d22bba15001f/foo123-0.2.0/src/lib.rs",
      ].join("\0") + "\0",
      "utf8",
    ),
  });
  const result = recoverRustSourceFingerprints(
    bytes,
    readBinaryContainer(bytes),
  );
  expect(result.inferred_crates.truncated).toBe(false);
  expect(result.inferred_crates.discovered_count).toBe(2);
  expect(
    result.inferred_crates.items.map(({ name, version }) => ({
      name,
      version,
    })),
  ).toEqual([
    { name: "_123foo", version: "0.1.0" },
    { name: "foo123", version: "0.2.0" },
  ]);

  const validReport = {
    artifact: {
      path: "/artifacts/digit-check",
      sha256: "b".repeat(64),
      bytes: bytes.length,
    },
    format: "elf" as const,
    architecture: "amd64",
    bits: 64 as const,
    byte_order: "little" as const,
    auditable_metadata: null,
    rustc_commit: null,
    inferred_crates: result.inferred_crates,
    rustc_versions: result.rustc_versions,
    limitations: [],
  };
  expect(rustBinarySchema.safeParse(validReport).success).toBe(true);

  const digitPrefixedReport = structuredClone(validReport);
  digitPrefixedReport.inferred_crates.items[0]!.name = "123foo";
  expect(rustBinarySchema.safeParse(digitPrefixedReport).success).toBe(false);
});
