import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  inspectPacketFieldsInputSchema,
  type InspectPacketFieldsInput,
} from "../domain/captures/packetFields.js";
import type { StableArtifactSnapshot } from "../resources/readStableArtifact.js";
import type { LinuxResourceLimits } from "../process/LinuxResourceLimits.js";
import { PrivateRuntimeRoot } from "../process/PrivateRuntimeRoot.js";
import type {
  OwnedProviderProcessSpawnOptions,
  ProviderProcessHandle,
  SpawnedOwnedProviderProcess,
} from "../process/ProviderProcess.js";
import type {
  OwnedProcessGroup,
  ProcessCleanupResult,
} from "../process/ProcessOwnership.js";
import { TsharkCaptureProvider } from "./TsharkCaptureProvider.js";
import {
  createFieldGlossaryCache,
  pluginListDigest,
  type FieldGlossaryCache,
  type FieldGlossaryIdentity,
} from "./fieldGlossaryCache.js";
import type { FieldGlossaryParseLimits } from "./parseFieldDiscovery.js";

const VERSION_BANNER = "tshark (Wireshark) 4.6.9\n";
const GLOSSARY = [
  "P\tframe\tframe",
  "P\tip\tip",
  "P\ttcp\ttcp",
  "F\tip.addr\tip.addr\tFT_IPv4\tip\t0x0\t0\tSource or Destination Address",
  "F\tip.src\tip.src\tFT_IPv4\tip\t0x0\t0\tSource Address",
  "F\tip.dst\tip.dst\tFT_IPv4\tip\t0x0\t0\tDestination Address",
  "F\ttcp.port\ttcp.port\tFT_UINT16\ttcp\t0x0\t0\tSource or Destination Port",
  "F\ttcp.srcport\ttcp.srcport\tFT_UINT16\ttcp\t0x0\t0\tSource Port",
].join("\n");
const PLUGINS_V1 =
  "gryphon.so\t0.0.4\tdissector\t/usr/lib/wireshark/plugins/4.6/gryphon.so";
const PLUGINS_V2 = [
  PLUGINS_V1,
  "acme.so\t1.2.3\tdissector\t/usr/lib/wireshark/plugins/4.6/acme.so",
].join("\n");

class FakeProcess extends EventEmitter implements ProviderProcessHandle {
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly exitCode = 0;
  readonly signalCode = null;
  readonly pid = 4242;

  constructor(stdoutText: string, stderrText = "") {
    super();
    this.stdout = Readable.from([Buffer.from(stdoutText, "utf8")]);
    this.stderr = Readable.from(
      stderrText === "" ? [] : [Buffer.from(stderrText, "utf8")],
    );
    let ended = 0;
    const finish = () => {
      if (++ended < 2) return;
      this.emit("exit", 0, null);
      this.emit("close", 0, null);
    };
    this.stdout.on("end", finish);
    this.stderr.on("end", finish);
  }

  kill(): boolean {
    return true;
  }
}

const spawnFake = (
  stdoutText: string,
  stderrText = "",
): SpawnedOwnedProviderProcess => ({
  process: new FakeProcess(stdoutText, stderrText),
  ownership: {} as OwnedProcessGroup,
  cleanup: async (): Promise<ProcessCleanupResult> => ({
    cleaned: true,
    signaled: false,
  }),
});

const input = (
  overrides: Partial<InspectPacketFieldsInput> = {},
): InspectPacketFieldsInput => inspectPacketFieldsInputSchema.parse(overrides);

/** Records cache operations in order so close/drain ordering is observable. */
const createSpyCache = () => {
  const inner = createFieldGlossaryCache();
  const ops: string[] = [];
  const cache: FieldGlossaryCache = {
    lookup: (identity) => inner.lookup(identity),
    store: (identity, records) => {
      ops.push("store");
      return inner.store(identity, records);
    },
    clear: () => {
      ops.push("clear");
      inner.clear();
    },
  };
  return { cache, ops };
};

interface ProviderTestFakes {
  readonly fakeTshark: string;
  readonly fakePrlimit: string;
  readonly readArtifact: (
    path: string,
    maximumBytes: number,
  ) => Promise<StableArtifactSnapshot>;
}

const makeProvider = (
  fakes: ProviderTestFakes,
  overrides: {
    cache?: FieldGlossaryCache;
    limits?: FieldGlossaryParseLimits;
  } = {},
) => {
  const localCalls = { version: 0, fields: 0, plugins: 0 };
  let plugins = PLUGINS_V1;
  let pluginsStderr = "";
  let fieldsGate: (() => Promise<void>) | undefined;
  const launcher = async (
    spawn: OwnedProviderProcessSpawnOptions,
  ): Promise<SpawnedOwnedProviderProcess> => {
    const args = spawn.arguments ?? [];
    if (args.includes("--version")) {
      localCalls.version++;
      return spawnFake(VERSION_BANNER);
    }
    if (args.includes("plugins")) {
      localCalls.plugins++;
      return spawnFake(plugins, pluginsStderr);
    }
    if (args.includes("-G")) {
      localCalls.fields++;
      if (fieldsGate !== undefined) await fieldsGate();
      return spawnFake(GLOSSARY);
    }
    throw new Error(`unexpected tshark args: ${args.join(" ")}`);
  };
  const readLimits = async (
    configured: LinuxResourceLimits,
  ): Promise<LinuxResourceLimits> => configured;
  const made = new TsharkCaptureProvider(
    {
      ...process.env,
      REA_TSHARK_COMMAND: fakes.fakeTshark,
      REA_TSHARK_PRLIMIT_COMMAND: fakes.fakePrlimit,
    },
    launcher,
    () => PrivateRuntimeRoot.create({ prefix: "rea-tshark-test-" }),
    "linux",
    fakes.readArtifact,
    readLimits,
    overrides.cache,
    overrides.limits,
  );
  return {
    provider: made,
    calls: localCalls,
    setPlugins: (next: string) => {
      plugins = next;
    },
    setPluginsStderr: (next: string) => {
      pluginsStderr = next;
    },
    setFieldsGate: (gate: () => Promise<void>) => {
      fieldsGate = gate;
    },
  };
};

interface FieldPageReport {
  records: { abbreviation: string }[];
  tool: { plugins_diagnostics: string };
  output_window: {
    examined: number;
    matching: number;
    returned: number;
    has_more: boolean;
    record_budget_reached: boolean;
  };
}

const expectFieldPage = (
  execution: { result: unknown },
  abbreviations: string[],
  outputWindow: FieldPageReport["output_window"],
) => {
  const report = execution.result as unknown as FieldPageReport;
  expect(report.records.map((record) => record.abbreviation)).toEqual(
    abbreviations,
  );
  expect(report.output_window).toEqual(outputWindow);
};

/** Fake tshark + limiter executables and the bytes the artifact reader returns. */
const createFixtures = async () => {
  const directory = await mkdtemp(join(tmpdir(), "rea-tshark-test-"));
  const fakeTshark = join(directory, "tshark");
  await writeFile(fakeTshark, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await chmod(fakeTshark, 0o755);
  // The limiter is never executed — the injected launcher owns every spawn —
  // but the provider resolves and checks it, so it must be a real executable
  // fixture instead of the host's /usr/bin/prlimit.
  const fakePrlimit = join(directory, "prlimit");
  await writeFile(fakePrlimit, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await chmod(fakePrlimit, 0o755);
  const fakeBytes = Buffer.from("fake-tshark-binary-v1", "utf8");
  const sha256 = createHash("sha256").update(fakeBytes).digest("hex");
  return { directory, fakeTshark, fakePrlimit, fakeBytes, sha256 };
};

describe("TsharkCaptureProvider field glossary cache", () => {
  let directory: string;
  let fakeTshark: string;
  let fakePrlimit: string;
  let fakeBytes: Buffer;
  let currentSha256: string;
  let provider: TsharkCaptureProvider;
  let calls: { version: number; fields: number; plugins: number };
  let setPlugins: (next: string) => void;
  let setPluginsStderr: (next: string) => void;
  let extraProviders: TsharkCaptureProvider[];
  let fakes: ProviderTestFakes;

  beforeEach(async () => {
    const fixtures = await createFixtures();
    directory = fixtures.directory;
    fakeTshark = fixtures.fakeTshark;
    fakePrlimit = fixtures.fakePrlimit;
    fakeBytes = fixtures.fakeBytes;
    currentSha256 = fixtures.sha256;
    extraProviders = [];
    const readArtifact = async (
      _path: string,
      _maximumBytes: number,
    ): Promise<StableArtifactSnapshot> => ({
      bytes: fakeBytes,
      sha256: currentSha256,
    });
    const setup = makeProvider(
      (fakes = { fakeTshark, fakePrlimit, readArtifact }),
    );
    provider = setup.provider;
    calls = setup.calls;
    setPlugins = setup.setPlugins;
    setPluginsStderr = setup.setPluginsStderr;
  });

  afterEach(async () => {
    for (const extra of extraProviders)
      await extra.close().catch(() => undefined);
    await provider.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  });

  it("dumps the glossary once across pages of the same tool", async () => {
    const first = await provider.inspectFields(
      input({ kind: "fields", limit: 2, offset: 0 }),
    );
    if (!first.ok) throw new Error(`first page failed: ${first.error}`);
    const second = await provider.inspectFields(
      input({ kind: "fields", limit: 2, offset: 2 }),
    );
    if (!second.ok) throw new Error(`second page failed: ${second.error}`);
    expect(calls).toEqual({ version: 2, fields: 1, plugins: 2 });
    expectFieldPage(first.value, ["ip.addr", "ip.src"], {
      examined: 5,
      matching: 5,
      returned: 2,
      has_more: true,
      record_budget_reached: false,
    });
    expectFieldPage(second.value, ["ip.dst", "tcp.port"], {
      examined: 5,
      matching: 5,
      returned: 2,
      has_more: true,
      record_budget_reached: false,
    });
    expect(first.value.limitations.join(" ")).toContain("cached in memory");
  });

  it("retains plugin probe warnings on cache misses and hits", async () => {
    const warning = "tshark: Warning: plugin 'gryphon.so' failed to load\n";
    setPluginsStderr(warning);
    const first = await provider.inspectFields(
      input({ kind: "fields", limit: 1, offset: 0 }),
    );
    if (!first.ok) throw new Error(`first page failed: ${first.error}`);
    const second = await provider.inspectFields(
      input({ kind: "fields", limit: 1, offset: 1 }),
    );
    if (!second.ok) throw new Error(`second page failed: ${second.error}`);
    // The glossary dump ran once (second page is a cache hit), but the
    // plugin probe ran during both requests, so both reports keep its
    // stderr instead of dropping it.
    expect(calls).toEqual({ version: 2, fields: 1, plugins: 2 });
    expect(
      (first.value.result as unknown as FieldPageReport).tool
        .plugins_diagnostics,
    ).toBe(warning);
    expect(
      (second.value.result as unknown as FieldPageReport).tool
        .plugins_diagnostics,
    ).toBe(warning);
  });

  it("dumps again when the tool identity changes", async () => {
    const first = await provider.inspectFields(
      input({ kind: "fields", limit: 1 }),
    );
    if (!first.ok) throw new Error(`first call failed: ${first.error}`);
    expect(calls.fields).toBe(1);
    currentSha256 = "c".repeat(64);
    const second = await provider.inspectFields(
      input({ kind: "fields", limit: 1 }),
    );
    if (!second.ok) throw new Error(`second call failed: ${second.error}`);
    expect(calls.fields).toBe(2);
  });

  it("re-dumps when the installed plugin list changes", async () => {
    const first = await provider.inspectFields(
      input({ kind: "fields", limit: 1 }),
    );
    if (!first.ok) throw new Error(`first call failed: ${first.error}`);
    expect(calls).toEqual({ version: 1, fields: 1, plugins: 1 });
    setPlugins(PLUGINS_V2);
    const second = await provider.inspectFields(
      input({ kind: "fields", limit: 1 }),
    );
    if (!second.ok) throw new Error(`second call failed: ${second.error}`);
    expect(calls.fields).toBe(2);
    expect(calls.plugins).toBe(2);
    const third = await provider.inspectFields(
      input({ kind: "fields", limit: 1 }),
    );
    if (!third.ok) throw new Error(`third call failed: ${third.error}`);
    expect(calls.fields).toBe(2);
    expect(calls.plugins).toBe(3);
  });

  it("answers the page without caching when the glossary exceeds the retention caps", async () => {
    const setup = makeProvider(fakes, {
      limits: { maxSourceBytes: 1_000_000, maxRecords: 3 },
    });
    extraProviders.push(setup.provider);
    const first = await setup.provider.inspectFields(
      input({ kind: "fields", limit: 2, offset: 0 }),
    );
    if (!first.ok) throw new Error(`first page failed: ${first.error}`);
    const firstReport = first.value.result as unknown as {
      records: { abbreviation: string }[];
    };
    expect(firstReport.records.map((record) => record.abbreviation)).toEqual([
      "ip.addr",
      "ip.src",
    ]);
    const second = await setup.provider.inspectFields(
      input({ kind: "fields", limit: 2, offset: 2 }),
    );
    if (!second.ok) throw new Error(`second page failed: ${second.error}`);
    // Nothing was retained, so the second page pays a fresh dump.
    expect(setup.calls.fields).toBe(2);
  });

  it("leaves no retained glossary when close drains an in-flight dump", async () => {
    const spy = createSpyCache();
    const setup = makeProvider(fakes, { cache: spy.cache });
    let releaseDump!: () => void;
    const dumpStarted = new Promise<void>((resolve) => {
      setup.setFieldsGate(async () => {
        resolve();
        await new Promise<void>((release) => {
          releaseDump = release;
        });
      });
    });
    const first = setup.provider.inspectFields(
      input({ kind: "fields", limit: 1 }),
    );
    await dumpStarted;
    const closing = setup.provider.close();
    releaseDump();
    const [result] = await Promise.all([first, closing]);
    if (!result.ok) throw new Error(`request failed: ${result.error}`);
    const identity: FieldGlossaryIdentity = {
      path: fakeTshark,
      sha256: currentSha256,
      versionBanner: VERSION_BANNER,
      pluginsDigest: pluginListDigest(PLUGINS_V1),
    };
    expect(spy.ops).toEqual(["clear", "store", "clear"]);
    expect(spy.cache.lookup(identity)).toBeUndefined();
  });
});
