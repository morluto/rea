import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { expect, it } from "vitest";
import { ArtifactReaderFailure } from "../../artifacts/ArtifactReader.js";
import {
  inspectKernelBuildConfigInputSchema,
  kernelBuildConfigSchema,
  type InspectKernelBuildConfigInput,
} from "../../domain/native/kernelBuildConfig.js";
import {
  badCrcKernelConfigFixture,
  bzImageFixture,
  bzImageGzipFixture,
  bzImageTruncatedGzipFixture,
  bzImageXzFixture,
  embeddedKernelConfig,
  headerCrcGzipMember,
  kernelBuildConfigFixture,
  LONG_KERNEL_CONFIG_STRING,
  longStringKernelConfigFixture,
  nonConfigGzipFixture,
  plainIkcfgStringFixture,
  SAMPLE_KERNEL_BANNER,
  SAMPLE_KERNEL_CONFIG,
  trailingBytesKernelConfigFixture,
  truncatedKernelConfigFixture,
} from "./KernelBuildConfig.fixture.js";
import { parseKernelBuildConfig } from "./KernelBuildConfig.js";

const artifactPath = "/artifacts/vmlinux";

const parse = (
  bytes: Buffer,
  extra: Partial<Omit<InspectKernelBuildConfigInput, "path">> = {},
) =>
  kernelBuildConfigSchema.parse(
    parseKernelBuildConfig(
      bytes,
      { path: artifactPath, sha256: "ab".repeat(32), bytes: bytes.length },
      inspectKernelBuildConfigInputSchema.parse({
        path: artifactPath,
        ...extra,
      }),
    ),
  );

it("reads the banner and the gzip IKCFG config after skipping a decoy marker", () => {
  const bytes = kernelBuildConfigFixture();
  const report = parse(bytes);
  expect(report.format).toBe("elf");
  expect(report.payload.status).toBe("uncompressed");
  expect(report.banner).toMatchObject({
    status: "present",
    text: SAMPLE_KERNEL_BANNER,
    version: "6.6.0",
    builder: "build@host",
    compiler:
      "gcc (Debian 12.2.0-14) 12.2.0, GNU ld (GNU Binutils for Debian) 2.40",
    location: { space: "file", offset: 64 },
  });
  const embedded = embeddedKernelConfig();
  const marker = bytes.indexOf(embedded);
  expect(report.config).toMatchObject({
    status: "present",
    reason: null,
    option_count: 9,
    matched_count: 9,
    marker: { space: "file", offset: marker, bytes: 8 },
    gzip: { space: "file", offset: marker + 8, bytes: embedded.length - 16 },
    end_marker: { offset: marker + embedded.length - 8, bytes: 8 },
    sha256: createHash("sha256").update(SAMPLE_KERNEL_CONFIG).digest("hex"),
  });
  expect(
    report.config.entries.map((entry) => [entry.name, entry.kind, entry.value]),
  ).toEqual([
    ["CONFIG_SECURITY_SELINUX", "y", "y"],
    ["CONFIG_STACKPROTECTOR", "y", "y"],
    ["CONFIG_MODULE_SIG", "m", "m"],
    ["CONFIG_LOCALVERSION", "string", ""],
    ["CONFIG_DEFAULT_HOSTNAME", "string", "(none)"],
    ["CONFIG_CMDLINE", "string", 'console=ttyS0 "debug"'],
    ["CONFIG_HZ", "number", "250"],
    ["CONFIG_PAGE_OFFSET", "number", "0xC0000000"],
    ["CONFIG_MODULE_SIG_FORCE", "not_set", null],
  ]);
  expect(report.coverage).toEqual({
    status: "complete",
    examined_bytes: bytes.length,
    examined_entries: 9,
  });
});

it("filters by exact name and pages without changing the option count", () => {
  const named = parse(kernelBuildConfigFixture(), {
    name: "CONFIG_MODULE_SIG_FORCE",
  });
  expect(named.config).toMatchObject({
    option_count: 9,
    matched_count: 1,
    name: "CONFIG_MODULE_SIG_FORCE",
    entries: [{ name: "CONFIG_MODULE_SIG_FORCE", kind: "not_set" }],
  });
  const paged = parse(kernelBuildConfigFixture(), { offset: 7, limit: 5 });
  expect(paged.config.entries.map((entry) => entry.name)).toEqual([
    "CONFIG_PAGE_OFFSET",
    "CONFIG_MODULE_SIG_FORCE",
  ]);
  expect(
    parse(kernelBuildConfigFixture(), { offset: 50 }).config.entries,
  ).toEqual([]);
});

it("accepts a string value longer than 4096 characters", () => {
  expect(LONG_KERNEL_CONFIG_STRING.length).toBeGreaterThan(4096);
  const report = parse(longStringKernelConfigFixture());
  expect(report.config).toMatchObject({
    status: "present",
    option_count: 2,
  });
  expect(report.config.entries[1]).toMatchObject({
    name: "CONFIG_EXTRA_FIRMWARE",
    kind: "string",
    value: `${LONG_KERNEL_CONFIG_STRING} "q" \\`,
  });
  expect(
    parse(longStringKernelConfigFixture(), {
      name: "CONFIG_SECURITY_SELINUX",
    }).config,
  ).toMatchObject({ status: "present", matched_count: 1 });
});

it("keeps the strict grammar for malformed quoted values", () => {
  for (const value of ['"open', '"bad \\q"', '"a"b"', '"tail\\"'])
    expect(
      parse(embeddedKernelConfig(`CONFIG_X=${value}\n`)).config.status,
    ).toBe("malformed");
});

it("does not treat an ordinary IKCFG_ST string as a config", () => {
  const report = parse(plainIkcfgStringFixture());
  expect(report.config).toMatchObject({
    status: "absent",
    reason: null,
    marker: null,
  });
  expect(report.banner.status).toBe("present");
  expect(report.coverage.status).toBe("complete");
});

it("skips a member that is not immediately followed by IKCFG_ED", () => {
  expect(parse(trailingBytesKernelConfigFixture()).config.status).toBe(
    "absent",
  );
});

it("reports a framed member whose text fails the grammar as malformed, not absent", () => {
  const bytes = nonConfigGzipFixture();
  const report = parse(bytes);
  expect(report.config).toMatchObject({
    status: "malformed",
    reason: "config_text_invalid",
    marker: { space: "file", offset: 64, bytes: 8 },
    gzip: { space: "file", offset: 72, bytes: bytes.length - 64 - 16 },
    end_marker: { space: "file", offset: bytes.length - 8, bytes: 8 },
    sha256: null,
    option_count: 0,
    entries: [],
  });
  expect(report.coverage.status).toBe("incomplete");
  expect(
    report.limitations.some((line) => line.includes("not a .config")),
  ).toBe(true);
});

it("reports a framed member with a bad CRC-32 as malformed, not absent", () => {
  const report = parse(badCrcKernelConfigFixture());
  expect(report.config).toMatchObject({
    status: "malformed",
    reason: "config_gzip_invalid",
    marker: { offset: 64 },
    sha256: null,
    option_count: 0,
  });
  expect(report.coverage.status).toBe("incomplete");
  expect(report.limitations.some((line) => line.includes("CRC-32"))).toBe(true);
});

it("checks the optional gzip header CRC before accepting a member", () => {
  const plain = Buffer.from(SAMPLE_KERNEL_CONFIG, "latin1");
  const frame = (member: Buffer): Buffer =>
    Buffer.concat([Buffer.from("IKCFG_ST"), member, Buffer.from("IKCFG_ED")]);
  expect(parse(frame(headerCrcGzipMember(plain))).config).toMatchObject({
    status: "present",
    option_count: 9,
  });
  const good = headerCrcGzipMember(plain);
  const damaged = headerCrcGzipMember(
    plain,
    (good.readUInt16LE(17) ^ 0xffff) & 0xffff,
  );
  expect(parse(frame(damaged)).config.status).not.toBe("present");
  const payload = parse(
    bzImageFixture(
      headerCrcGzipMember(
        Buffer.concat([
          Buffer.from(`${SAMPLE_KERNEL_BANNER}\0`, "latin1"),
          embeddedKernelConfig(),
        ]),
        0,
      ),
    ),
  );
  expect(payload.payload.status).toBe("malformed");
  expect(payload.config.reason).toBe("payload_gzip_invalid");
});

it("reports a framed member that does not decode as malformed, not absent", () => {
  const member = gzipSync(Buffer.from(SAMPLE_KERNEL_CONFIG, "latin1"));
  const damaged = Buffer.from(member);
  // The first DEFLATE byte becomes a reserved block type.
  damaged[10] = 0x07;
  const cutOff = member.subarray(0, member.length - 20);
  for (const body of [damaged, cutOff]) {
    const bytes = Buffer.concat([
      Buffer.from("IKCFG_ST"),
      body,
      Buffer.from("IKCFG_ED"),
    ]);
    const report = parse(bytes);
    expect(report.config).toMatchObject({
      status: "malformed",
      reason: "config_gzip_invalid",
      marker: { space: "file", offset: 0, bytes: 8 },
      gzip: { space: "file", offset: 8, bytes: body.length },
      end_marker: { space: "file", offset: bytes.length - 8, bytes: 8 },
    });
    expect(report.coverage.status).toBe("incomplete");
    expect(
      parse(Buffer.concat([bytes, embeddedKernelConfig()])).config.status,
    ).toBe("present");
  }
});

it("prefers a valid config over an earlier malformed blob", () => {
  const report = parse(
    Buffer.concat([badCrcKernelConfigFixture(), embeddedKernelConfig()]),
  );
  expect(report.config).toMatchObject({ status: "present", option_count: 9 });
  expect(report.coverage.status).toBe("complete");
});

it("reports a truncated IKCFG member as incomplete, not absent", () => {
  const report = parse(truncatedKernelConfigFixture());
  expect(report.config).toMatchObject({
    status: "incomplete",
    reason: "config_gzip_truncated",
  });
  expect(report.coverage.status).toBe("incomplete");
});

it("inflates a bzImage gzip payload and reports payload-relative offsets", () => {
  const report = parse(bzImageGzipFixture());
  expect(report.format).toBe("file");
  expect(report.payload).toMatchObject({
    container: "bzimage",
    codec: "gzip",
    status: "inflated",
    offset: 5 * 512 + 16,
  });
  expect(report.banner).toMatchObject({
    status: "present",
    version: "6.6.0",
    location: { space: "inflated_payload", offset: 0 },
  });
  expect(report.config).toMatchObject({
    status: "present",
    option_count: 9,
    marker: { space: "inflated_payload" },
  });
  expect(report.coverage.examined_bytes).toBe(report.payload.inflated_bytes);
});

it("names an xz bzImage payload as unsupported without searching it", () => {
  const report = parse(bzImageXzFixture());
  expect(report).toMatchObject({
    payload: { container: "bzimage", codec: "xz", status: "unsupported" },
    next_probe: { operation: "external_decompression" },
    banner: { status: "unknown" },
    config: { status: "unsupported", reason: "payload_codec_unsupported" },
    coverage: { status: "unsupported", examined_bytes: 0 },
  });
});

it("keeps truncated and unusable bzImage payloads incomplete", () => {
  const truncated = parse(bzImageTruncatedGzipFixture());
  expect(truncated.payload.status).toBe("truncated");
  expect(truncated.config.reason).toBe("payload_truncated");
  expect(truncated.coverage.status).toBe("incomplete");

  const old = parse(bzImageFixture(gzipSync("x"), { version: 0x0206 }));
  expect(old.payload.status).toBe("unavailable");
  expect(old.config.reason).toBe("setup_header_payload_unavailable");

  const short = bzImageFixture(gzipSync("x"));
  short.writeUInt32LE(0xffff, 0x24c);
  expect(parse(short).config.reason).toBe("payload_truncated");

  const garbage = bzImageFixture(Buffer.from("not compressed"));
  expect(parse(garbage)).toMatchObject({
    payload: { codec: null, status: "unsupported" },
    config: { reason: "unrecognized_payload_codec" },
  });
});

it("detects the bzImage payload codec within the declared payload only", () => {
  const image = bzImageXzFixture();
  image.writeUInt32LE(1, 0x24c);
  expect(parse(image)).toMatchObject({
    payload: { codec: null, status: "unsupported", bytes: 1 },
    config: { reason: "unrecognized_payload_codec" },
  });
});

it("names a whole-file codec stream without inflating it", () => {
  const report = parse(gzipSync(Buffer.from(SAMPLE_KERNEL_CONFIG)));
  expect(report).toMatchObject({
    payload: { container: "file", codec: "gzip", status: "unsupported" },
    config: { status: "unsupported" },
    next_probe: { operation: "external_decompression" },
  });
});

it("fails closed when a config exceeds its entry or inflation budget", () => {
  expect(() => parse(kernelBuildConfigFixture(), { max_entries: 2 })).toThrow(
    ArtifactReaderFailure,
  );
  expect(() =>
    parse(kernelBuildConfigFixture(), { max_config_bytes: 64 }),
  ).toThrow(/max_config_bytes/u);
  expect(() => parse(bzImageGzipFixture(), { max_payload_bytes: 64 })).toThrow(
    /max_payload_bytes/u,
  );
});

it("ignores banner-shaped text that is unterminated or lacks a version", () => {
  const bytes = Buffer.concat([
    Buffer.from("Linux version of the docs\0"),
    Buffer.from("Linux version 5.10.0"),
  ]);
  expect(parse(bytes).banner.status).toBe("absent");
});

const framed = (member: Buffer): Buffer =>
  Buffer.concat([Buffer.from("IKCFG_ST"), member, Buffer.from("IKCFG_ED")]);

it("stops inflating decoy candidates after the candidate cap and reports incomplete", () => {
  const decoy = framed(gzipSync(Buffer.from("hello world\n")));
  const report = parse(
    Buffer.concat([
      ...Array.from({ length: 16 }, () => decoy),
      embeddedKernelConfig(),
    ]),
  );
  expect(report.config).toMatchObject({
    status: "incomplete",
    reason: "config_search_exhausted",
    marker: null,
  });
  expect(report.coverage.status).toBe("incomplete");
  expect(
    report.limitations.some((line) => line.includes("16 IKCFG_ST gzip")),
  ).toBe(true);
});

it("caps total inflated bytes across candidates below each member's own budget", () => {
  const decoy = framed(gzipSync(Buffer.alloc(4000, 0x61)));
  const report = parse(
    Buffer.concat([
      ...Array.from({ length: 5 }, () => decoy),
      embeddedKernelConfig(),
    ]),
    { max_config_bytes: 4096 },
  );
  expect(report.config).toMatchObject({
    status: "incomplete",
    reason: "config_search_exhausted",
  });
  // Under the cap, the same decoys still yield the later config.
  expect(
    parse(Buffer.concat([decoy, decoy, embeddedKernelConfig()]), {
      max_config_bytes: 4096,
    }).config.status,
  ).toBe("present");
});

it("charges cut-off decoy members against the total inflate budget", () => {
  // Incompressible bytes, so the cut-off stream inflates under the limit.
  const noise = Buffer.concat(
    Array.from({ length: 1875 }, (_, index) =>
      createHash("sha256").update(String(index)).digest(),
    ),
  );
  // Each decoy's deflate stream is cut off by its own IKCFG_ED.
  const decoy = framed(gzipSync(noise).subarray(0, 30_000));
  const report = parse(
    Buffer.concat([
      ...Array.from({ length: 4 }, () => decoy),
      embeddedKernelConfig(),
    ]),
    { max_config_bytes: 65536 },
  );
  expect(report.config).toMatchObject({
    status: "incomplete",
    reason: "config_search_exhausted",
  });
});

it("bounds each candidate's inflate input by its closing IKCFG_ED", () => {
  const bomb = gzipSync(Buffer.alloc(1 << 20));
  const report = parse(
    Buffer.concat([
      Buffer.from("IKCFG_ST"),
      bomb.subarray(0, 100),
      Buffer.from("IKCFG_ED"),
      bomb.subarray(100),
      embeddedKernelConfig(),
    ]),
    { max_config_bytes: 65536 },
  );
  expect(report.config).toMatchObject({ status: "present", option_count: 9 });
});

it("does not let an oversized decoy hide a later config", () => {
  const decoy = Buffer.concat([
    Buffer.from("IKCFG_ST"),
    gzipSync(Buffer.alloc(200_000)),
    Buffer.from("IKCFG_ED"),
  ]);
  const report = parse(Buffer.concat([decoy, embeddedKernelConfig()]), {
    max_config_bytes: 65536,
  });
  expect(report.config).toMatchObject({ status: "present", option_count: 9 });
});

it("finds a banner after overlapping unterminated repeats in one linear scan", () => {
  const repeats = Buffer.from("Linux version ".repeat(200_000));
  const rejected = parse(Buffer.concat([repeats, Buffer.from([0x01])]));
  expect(rejected.banner.status).toBe("absent");
  const bytes = Buffer.concat([
    repeats,
    Buffer.from([0x01]),
    Buffer.from("Linux version x ".repeat(100)),
    Buffer.from("Linux version 6.1.0 (a@b) (gcc) #1\n"),
  ]);
  const report = parse(bytes);
  expect(report.banner).toMatchObject({
    status: "present",
    text: "Linux version 6.1.0 (a@b) (gcc) #1",
    version: "6.1.0",
    location: { offset: bytes.length - 35, bytes: 34 },
  });
});

it("honors cancellation during the marker, inflate, and banner scans", () => {
  const input = inspectKernelBuildConfigInputSchema.parse({
    path: artifactPath,
  });
  const artifact = { path: artifactPath, sha256: "ab".repeat(32), bytes: 0 };
  const abortAfter = (checks: number): AbortSignal => {
    let reads = 0;
    return {
      get aborted() {
        reads += 1;
        return reads > checks;
      },
      reason: new Error("stop"),
    } as unknown as AbortSignal;
  };
  const decoy = framed(gzipSync(Buffer.from("hello world\n")));
  const cancelled = (bytes: Buffer, checks: number): unknown => {
    try {
      parseKernelBuildConfig(bytes, artifact, input, abortAfter(checks));
    } catch (error) {
      return error;
    }
    return null;
  };
  for (const [bytes, checks] of [
    [Buffer.concat([decoy, decoy, decoy]), 2],
    [kernelBuildConfigFixture(), 0],
    [Buffer.from("Linux version ".repeat(20_000)), 1],
    [bzImageGzipFixture(), 0],
  ] as const) {
    const error = cancelled(bytes, checks);
    expect(error).toBeInstanceOf(ArtifactReaderFailure);
    expect((error as ArtifactReaderFailure).reason).toBe("cancelled");
  }
});
