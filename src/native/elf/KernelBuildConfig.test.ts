import { createHash } from "node:crypto";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
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
import {
  KernelBuildConfigBudgetFailure,
  parseKernelBuildConfig,
} from "./KernelBuildConfig.js";

const artifactPath = "/artifacts/vmlinux";

const parse = async (
  bytes: Buffer,
  extra: Partial<Omit<InspectKernelBuildConfigInput, "path">> = {},
) =>
  kernelBuildConfigSchema.parse(
    await parseKernelBuildConfig(
      bytes,
      { path: artifactPath, sha256: "ab".repeat(32), bytes: bytes.length },
      inspectKernelBuildConfigInputSchema.parse({
        path: artifactPath,
        ...extra,
      }),
    ),
  );

it("reads the banner and the gzip IKCFG config after skipping a decoy marker", async () => {
  const bytes = kernelBuildConfigFixture();
  const report = await parse(bytes);
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

it("filters by exact name and pages without changing the option count", async () => {
  const named = await parse(kernelBuildConfigFixture(), {
    name: "CONFIG_MODULE_SIG_FORCE",
  });
  expect(named.config).toMatchObject({
    option_count: 9,
    matched_count: 1,
    name: "CONFIG_MODULE_SIG_FORCE",
    entries: [{ name: "CONFIG_MODULE_SIG_FORCE", kind: "not_set" }],
  });
  const paged = await parse(kernelBuildConfigFixture(), {
    offset: 7,
    limit: 5,
  });
  expect(paged.config.entries.map((entry) => entry.name)).toEqual([
    "CONFIG_PAGE_OFFSET",
    "CONFIG_MODULE_SIG_FORCE",
  ]);
  expect(
    (await parse(kernelBuildConfigFixture(), { offset: 50 })).config.entries,
  ).toEqual([]);
});

it("accepts a string value longer than 4096 characters", async () => {
  expect(LONG_KERNEL_CONFIG_STRING.length).toBeGreaterThan(4096);
  const report = await parse(longStringKernelConfigFixture());
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
    (
      await parse(longStringKernelConfigFixture(), {
        name: "CONFIG_SECURITY_SELINUX",
      })
    ).config,
  ).toMatchObject({ status: "present", matched_count: 1 });
});

it.each(["disabled", "assigned"])(
  "retains a long %s config name",
  async (kind) => {
    const name = `CONFIG_${"A".repeat(260)}`;
    const option = kind === "disabled" ? `# ${name} is not set` : `${name}=y`;
    const bytes = framed(gzipSync(Buffer.from(`${option}\nCONFIG_OK=y\n`)));
    const report = await parse(bytes, { name });
    expect(report.config).toMatchObject({
      status: "present",
      option_count: 2,
      matched_count: 1,
      entries: [{ name, kind: kind === "disabled" ? "not_set" : "y" }],
    });
  },
);

it("keeps the strict grammar for malformed quoted values", async () => {
  for (const value of [
    '"open',
    '"bad \\q"',
    '"a"b"',
    '"tail\\"',
    '"a\rb"',
    '"a\u2028b"',
    "y\u2028",
  ])
    expect(
      (
        await parse(
          framed(gzipSync(Buffer.from(`CONFIG_X=${value}\n`, "utf8"))),
        )
      ).config.status,
    ).toBe("malformed");
});

it("does not treat an ordinary IKCFG_ST string as a config", async () => {
  const report = await parse(plainIkcfgStringFixture());
  expect(report.config).toMatchObject({
    status: "absent",
    reason: null,
    marker: null,
  });
  expect(report.banner.status).toBe("present");
  expect(report.coverage.status).toBe("complete");
});

it("skips a member that is not immediately followed by IKCFG_ED", async () => {
  expect((await parse(trailingBytesKernelConfigFixture())).config.status).toBe(
    "absent",
  );
});

it("reports a framed member whose text fails the grammar as malformed, not absent", async () => {
  const bytes = nonConfigGzipFixture();
  const report = await parse(bytes);
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

it("reports a framed member with a bad CRC-32 as malformed, not absent", async () => {
  const report = await parse(badCrcKernelConfigFixture());
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

it("checks the optional gzip header CRC before accepting a member", async () => {
  const plain = Buffer.from(SAMPLE_KERNEL_CONFIG, "latin1");
  const frame = (member: Buffer): Buffer =>
    Buffer.concat([Buffer.from("IKCFG_ST"), member, Buffer.from("IKCFG_ED")]);
  expect((await parse(frame(headerCrcGzipMember(plain)))).config).toMatchObject(
    {
      status: "present",
      option_count: 9,
    },
  );
  const good = headerCrcGzipMember(plain);
  const damaged = headerCrcGzipMember(
    plain,
    (good.readUInt16LE(17) ^ 0xffff) & 0xffff,
  );
  expect((await parse(frame(damaged))).config.status).not.toBe("present");
  const payload = await parse(
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

it("reports a framed member that does not decode as malformed, not absent", async () => {
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
    const report = await parse(bytes);
    expect(report.config).toMatchObject({
      status: "malformed",
      reason: "config_gzip_invalid",
      marker: { space: "file", offset: 0, bytes: 8 },
      gzip: { space: "file", offset: 8, bytes: body.length },
      end_marker: { space: "file", offset: bytes.length - 8, bytes: 8 },
    });
    expect(report.coverage.status).toBe("incomplete");
    expect(
      (await parse(Buffer.concat([bytes, embeddedKernelConfig()]))).config
        .status,
    ).toBe("present");
  }
});

it("prefers a valid config over an earlier malformed blob", async () => {
  const report = await parse(
    Buffer.concat([badCrcKernelConfigFixture(), embeddedKernelConfig()]),
  );
  expect(report.config).toMatchObject({ status: "present", option_count: 9 });
  expect(report.coverage.status).toBe("complete");
});

it("reports a truncated IKCFG member as incomplete, not absent", async () => {
  const report = await parse(truncatedKernelConfigFixture());
  expect(report.config).toMatchObject({
    status: "incomplete",
    reason: "config_gzip_truncated",
  });
  expect(report.coverage.status).toBe("incomplete");
});

it("inflates a bzImage gzip payload and reports payload-relative offsets", async () => {
  const report = await parse(bzImageGzipFixture());
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

it("names an xz bzImage payload as unsupported without searching it", async () => {
  const report = await parse(bzImageXzFixture());
  expect(report).toMatchObject({
    payload: { container: "bzimage", codec: "xz", status: "unsupported" },
    next_probe: { operation: "external_decompression" },
    banner: { status: "unknown" },
    config: { status: "unsupported", reason: "payload_codec_unsupported" },
    coverage: { status: "unsupported", examined_bytes: 0 },
  });
});

it("keeps truncated and unusable bzImage payloads incomplete", async () => {
  const truncated = await parse(bzImageTruncatedGzipFixture());
  expect(truncated.payload.status).toBe("truncated");
  expect(truncated.config.reason).toBe("payload_truncated");
  expect(truncated.coverage.status).toBe("incomplete");

  const old = await parse(bzImageFixture(gzipSync("x"), { version: 0x0206 }));
  expect(old.payload.status).toBe("unavailable");
  expect(old.config.reason).toBe("setup_header_payload_unavailable");

  const short = bzImageFixture(gzipSync("x"));
  short.writeUInt32LE(0xffff, 0x24c);
  expect((await parse(short)).config.reason).toBe("payload_truncated");

  const garbage = bzImageFixture(Buffer.from("not compressed"));
  expect(await parse(garbage)).toMatchObject({
    payload: { codec: null, status: "unsupported" },
    config: { reason: "unrecognized_payload_codec" },
  });
});

it("detects the bzImage payload codec within the declared payload only", async () => {
  const image = bzImageXzFixture();
  image.writeUInt32LE(1, 0x24c);
  expect(await parse(image)).toMatchObject({
    payload: { codec: null, status: "unsupported", bytes: 1 },
    config: { reason: "unrecognized_payload_codec" },
  });
});

it("names a whole-file codec stream without inflating it", async () => {
  const report = await parse(gzipSync(Buffer.from(SAMPLE_KERNEL_CONFIG)));
  expect(report).toMatchObject({
    payload: { container: "file", codec: "gzip", status: "unsupported" },
    config: { status: "unsupported" },
    next_probe: { operation: "external_decompression" },
  });
});

it("fails closed when a config exceeds its entry or inflation budget", async () => {
  // Recovery reads the typed knob, never the message text.
  for (const [bytes, extra, knob] of [
    [kernelBuildConfigFixture(), { max_entries: 2 }, "max_entries"],
    [kernelBuildConfigFixture(), { max_config_bytes: 64 }, "max_config_bytes"],
    [bzImageGzipFixture(), { max_payload_bytes: 64 }, "max_payload_bytes"],
  ] as const) {
    const failure = parse(bytes, extra);
    await expect(failure).rejects.toBeInstanceOf(
      KernelBuildConfigBudgetFailure,
    );
    await expect(failure).rejects.toMatchObject({
      reason: "limit",
      boundary: "capacity",
      knob,
    });
  }
});

it("ignores banner-shaped text that is unterminated or lacks a version", async () => {
  const bytes = Buffer.concat([
    Buffer.from("Linux version of the docs\0"),
    Buffer.from("Linux version 5.10.0"),
  ]);
  expect((await parse(bytes)).banner.status).toBe("absent");
});

const framed = (member: Buffer): Buffer =>
  Buffer.concat([Buffer.from("IKCFG_ST"), member, Buffer.from("IKCFG_ED")]);

it("stops inflating decoy candidates after the candidate cap and reports incomplete", async () => {
  const decoy = framed(gzipSync(Buffer.from("hello world\n")));
  const report = await parse(
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

it("caps total inflated bytes across candidates below each member's own budget", async () => {
  const decoy = framed(gzipSync(Buffer.alloc(4000, 0x61)));
  const report = await parse(
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
    (
      await parse(Buffer.concat([decoy, decoy, embeddedKernelConfig()]), {
        max_config_bytes: 4096,
      })
    ).config.status,
  ).toBe("present");
});

it("charges cut-off decoy members against the total inflate budget", async () => {
  // Incompressible bytes, so the cut-off stream inflates under the limit.
  const noise = Buffer.concat(
    Array.from({ length: 1875 }, (_, index) =>
      createHash("sha256").update(String(index)).digest(),
    ),
  );
  // Each decoy's deflate stream is cut off by its own IKCFG_ED.
  const decoy = framed(gzipSync(noise).subarray(0, 30_000));
  const report = await parse(
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

it("bounds each candidate's inflate input by its closing IKCFG_ED", async () => {
  const bomb = gzipSync(Buffer.alloc(1 << 20));
  const report = await parse(
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

it("does not let an oversized decoy hide a later config", async () => {
  const decoy = Buffer.concat([
    Buffer.from("IKCFG_ST"),
    gzipSync(Buffer.alloc(200_000)),
    Buffer.from("IKCFG_ED"),
  ]);
  const report = await parse(Buffer.concat([decoy, embeddedKernelConfig()]), {
    max_config_bytes: 65536,
  });
  expect(report.config).toMatchObject({ status: "present", option_count: 9 });
});

it("finds a banner after overlapping unterminated repeats in one linear scan", async () => {
  const repeats = Buffer.from("Linux version ".repeat(200_000));
  const rejected = await parse(Buffer.concat([repeats, Buffer.from([0x01])]));
  expect(rejected.banner.status).toBe("absent");
  const bytes = Buffer.concat([
    repeats,
    Buffer.from([0x01]),
    Buffer.from("Linux version x ".repeat(100)),
    Buffer.from("Linux version 6.1.0 (a@b) (gcc) #1\n"),
  ]);
  const report = await parse(bytes);
  expect(report.banner).toMatchObject({
    status: "present",
    text: "Linux version 6.1.0 (a@b) (gcc) #1",
    version: "6.1.0",
    location: { offset: bytes.length - 35, bytes: 34 },
  });
});

it("honors cancellation during the marker, inflate, and banner scans", async () => {
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
  const cancelled = async (bytes: Buffer, checks: number): Promise<unknown> => {
    try {
      await parseKernelBuildConfig(bytes, artifact, input, abortAfter(checks));
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
    const error = await cancelled(bytes, checks);
    expect(error).toBeInstanceOf(ArtifactReaderFailure);
    expect((error as ArtifactReaderFailure).reason).toBe("cancelled");
  }
});

it("honors an abort raised while the parse is running", async () => {
  const input = inspectKernelBuildConfigInputSchema.parse({
    path: artifactPath,
  });
  const artifact = { path: artifactPath, sha256: "ab".repeat(32), bytes: 0 };
  for (const bytes of [
    kernelBuildConfigFixture(),
    bzImageGzipFixture(),
    Buffer.from("Linux version ".repeat(300_000)),
  ]) {
    const controller = new AbortController();
    const pending = parseKernelBuildConfig(
      bytes,
      artifact,
      input,
      controller.signal,
    );
    // Runs only once the parser gives the event loop a turn.
    setImmediate(() => controller.abort(new Error("stop")));
    const error: unknown = await Promise.resolve(pending).then(
      () => null,
      (cause: unknown) => cause,
    );
    expect(error).toBeInstanceOf(ArtifactReaderFailure);
    expect((error as ArtifactReaderFailure).reason).toBe("cancelled");
  }
});

it("yields to the event loop while decoding and validating one long value", async () => {
  const input = inspectKernelBuildConfigInputSchema.parse({
    path: artifactPath,
    max_config_bytes: 16 << 20,
  });
  const artifact = { path: artifactPath, sha256: "ab".repeat(32), bytes: 0 };
  const bytes = embeddedKernelConfig(
    `CONFIG_EXTRA_FIRMWARE="${"a".repeat(8 << 20)}"\n`,
  );
  // Each cancellation check records the event-loop turn it ran in. Checks
  // that all share one turn could never observe a live abort.
  let turns = 0;
  let running = true;
  const tick = (): void => {
    turns += 1;
    if (running) setImmediate(tick);
  };
  setImmediate(tick);
  const seen: number[] = [];
  const signal = {
    get aborted() {
      seen.push(turns);
      return false;
    },
    reason: undefined,
  } as unknown as AbortSignal;
  try {
    const report = await parseKernelBuildConfig(bytes, artifact, input, signal);
    expect(report.config).toMatchObject({ status: "present", option_count: 1 });
  } finally {
    running = false;
  }
  // Turns spent after the inflate returned, while the decoded text is parsed.
  const parsing = new Set(seen.slice(seen.indexOf(seen[1] ?? -1)));
  expect(parsing.size).toBeGreaterThanOrEqual(8);
});

it("does not keep the decoded config alive through a one-entry page", async () => {
  setFlagsFromString("--expose-gc");
  const gc = runInNewContext("gc") as () => void;
  // Longer than V8's 13-character minimum for a sliced string.
  const KEPT = "a page value long enough to be a slice";
  // About 0.9 MiB of text, below the size Node hands out as an external
  // string, so the decoded text is counted in heapUsed.
  const lines = Array.from(
    { length: 3500 },
    (_, index) =>
      `CONFIG_OPTION_NUMBER_${String(index)}="${"v".repeat(240)}${String(index)}"`,
  );
  const fixtures = Array.from({ length: 8 }, (_, page) =>
    embeddedKernelConfig(
      [...lines, `CONFIG_PAGE_${String(page)}="${KEPT}"`, ""].join("\n"),
    ),
  );
  const pages = [];
  gc();
  gc();
  const before = process.memoryUsage().heapUsed;
  for (const [page, bytes] of fixtures.entries())
    pages.push(await parse(bytes, { name: `CONFIG_PAGE_${String(page)}` }));
  gc();
  gc();
  const retained = process.memoryUsage().heapUsed - before;
  expect(pages.map((report) => report.config.entries[0]?.value)).toEqual(
    Array.from({ length: 8 }, () => KEPT),
  );
  // Eight pages that each pinned their decoded text would hold about 7 MiB.
  expect(retained).toBeLessThan(2 << 20);
});

it("yields to the event loop while marker searches find nothing", async () => {
  const input = inspectKernelBuildConfigInputSchema.parse({
    path: artifactPath,
  });
  const artifact = { path: artifactPath, sha256: "ab".repeat(32), bytes: 0 };
  // Every byte starts a possible IKCFG_ST, and no marker or banner exists.
  const bytes = Buffer.alloc(8 << 20, 0x49);
  let turns = 0;
  let running = true;
  const tick = (): void => {
    turns += 1;
    if (running) setImmediate(tick);
  };
  setImmediate(tick);
  const seen = new Set<number>();
  const signal = {
    get aborted() {
      seen.add(turns);
      return false;
    },
    reason: undefined,
  } as unknown as AbortSignal;
  try {
    const report = await parseKernelBuildConfig(bytes, artifact, input, signal);
    expect(report.config.status).toBe("absent");
    expect(report.banner.status).toBe("absent");
  } finally {
    running = false;
  }
  // Two 8 MiB searches with no match: checks must span many turns, not one.
  expect(seen.size).toBeGreaterThanOrEqual(8);
});

it("finds markers that straddle a search window boundary", async () => {
  for (const shift of [1, 4, 6]) {
    // The first window ends needle.length - 1 bytes past each MiB, so these
    // markers start inside one window and end in the next.
    const at = (1 << 20) + shift;
    const config = embeddedKernelConfig();
    const banner = Buffer.from("Linux version 6.1.0 (a@b) (gcc) #1\n");
    const bytes = Buffer.alloc((3 << 20) + config.length);
    banner.copy(bytes, at);
    config.copy(bytes, (2 << 20) + shift);
    const report = await parse(bytes);
    expect(report.banner).toMatchObject({
      status: "present",
      location: { offset: at },
    });
    expect(report.config).toMatchObject({
      status: "present",
      marker: { offset: (2 << 20) + shift },
    });
  }
});

it("retains incomplete coverage for a partial config end marker", async () => {
  const bytes = kernelBuildConfigFixture();
  const end = bytes.indexOf(
    Buffer.from("IKCFG_ED"),
    bytes.indexOf(Buffer.from("IKCFG_ST")) + 20,
  );
  const report = await parse(bytes.subarray(0, end + 7));
  expect(report.config.status).not.toBe("absent");
});

it("ignores marker bytes inside a gzip member", async () => {
  const bytes = Buffer.concat([
    kernelBuildConfigFixture().subarray(0, 64),
    Buffer.from("IKCFG_ST"),
    gzipSync(Buffer.from('CONFIG_LOCALVERSION="IKCFG_ED"\n'), { level: 0 }),
    Buffer.from("IKCFG_ED"),
  ]);
  expect((await parse(bytes)).config.status).toBe("present");
});
