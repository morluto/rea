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
import type { StableArtifactSnapshot } from "../artifacts/readStableArtifact.js";
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

class FakeProcess extends EventEmitter implements ProviderProcessHandle {
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly exitCode = 0;
  readonly signalCode = null;
  readonly pid = 4242;

  constructor(stdoutText: string) {
    super();
    this.stdout = Readable.from([Buffer.from(stdoutText, "utf8")]);
    this.stderr = Readable.from([]);
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

const input = (
  overrides: Partial<InspectPacketFieldsInput> = {},
): InspectPacketFieldsInput => inspectPacketFieldsInputSchema.parse(overrides);

describe("TsharkCaptureProvider field glossary cache", () => {
  let directory: string;
  let provider: TsharkCaptureProvider;
  let calls: { version: number; fields: number };
  let currentSha256: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "rea-tshark-test-"));
    const fakeTshark = join(directory, "tshark");
    await writeFile(fakeTshark, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await chmod(fakeTshark, 0o755);
    const fakeBytes = Buffer.from("fake-tshark-binary-v1", "utf8");
    currentSha256 = createHash("sha256").update(fakeBytes).digest("hex");
    calls = { version: 0, fields: 0 };
    const launcher = async (
      spawn: OwnedProviderProcessSpawnOptions,
    ): Promise<SpawnedOwnedProviderProcess> => {
      const args = spawn.arguments ?? [];
      let stdout: string;
      if (args.includes("--version")) {
        calls.version++;
        stdout = VERSION_BANNER;
      } else if (args.includes("-G")) {
        calls.fields++;
        stdout = GLOSSARY;
      } else {
        throw new Error(`unexpected tshark args: ${args.join(" ")}`);
      }
      return {
        process: new FakeProcess(stdout),
        ownership: {} as OwnedProcessGroup,
        cleanup: async (): Promise<ProcessCleanupResult> => ({
          cleaned: true,
          signaled: false,
        }),
      };
    };
    const readArtifact = async (
      _path: string,
      _maximumBytes: number,
    ): Promise<StableArtifactSnapshot> => ({
      bytes: fakeBytes,
      sha256: currentSha256,
    });
    const readLimits = async (
      configured: LinuxResourceLimits,
    ): Promise<LinuxResourceLimits> => configured;
    provider = new TsharkCaptureProvider(
      { ...process.env, REA_TSHARK_COMMAND: fakeTshark },
      launcher,
      () => PrivateRuntimeRoot.create({ prefix: "rea-tshark-test-" }),
      "linux",
      readArtifact,
      readLimits,
    );
  });

  afterEach(async () => {
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
    expect(calls).toEqual({ version: 2, fields: 1 });
    const firstReport = first.value.result as unknown as {
      records: { abbreviation: string }[];
      output_window: { matching: number; has_more: boolean };
    };
    const secondReport = second.value.result as unknown as {
      records: { abbreviation: string }[];
      output_window: { matching: number; has_more: boolean };
    };
    expect(firstReport.records.map((record) => record.abbreviation)).toEqual([
      "ip.addr",
      "ip.src",
    ]);
    expect(firstReport.output_window).toEqual({
      examined: 5,
      matching: 5,
      returned: 2,
      has_more: true,
    });
    expect(secondReport.records.map((record) => record.abbreviation)).toEqual([
      "ip.dst",
      "tcp.port",
    ]);
    expect(secondReport.output_window.has_more).toBe(true);
    expect(first.value.limitations.join(" ")).toContain("cached in memory");
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
});
