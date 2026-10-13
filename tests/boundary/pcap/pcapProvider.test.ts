import { createHash } from "node:crypto";
import { watch } from "node:fs";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, onTestFinished, test, vi } from "vitest";

import { PcapProvider } from "../../../src/pcap/PcapProvider.js";
import { projectAnalysisError } from "../../../src/domain/analysisErrorProjection.js";
import {
  pcapResultSchemas,
  type PcapRequest,
} from "../../../src/domain/pcap/pcapAnalysis.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { holdFirstFileRead } from "../../support/holdFirstFileRead.js";
import { PrivateRuntimeRoot } from "../../../src/process/PrivateRuntimeRoot.js";

const it = test.skipIf(process.platform !== "linux");

const CAPINFOS_OUTPUT = [
  "File name:           /work/capture.pcap",
  "File type:           Wireshark/tcpdump/... - pcap",
  "File encapsulation:  Ethernet",
  "Packet size limit:   file hdr: 262144 bytes",
  "Number of packets:   3",
  "Capture duration:    0.123 seconds",
].join("\n");

const TSHARK_JSON = JSON.stringify([
  {
    _source: {
      layers: {
        "frame.number": ["1"],
        "frame.protocols": ["eth:ethertype:ip:udp:dns"],
        "ip.src": ["192.168.1.100"],
        "ip.dst": ["8.8.8.8"],
        "dns.qry.name": ["api.example.com"],
        "dns.flags.response": ["1"],
        "dns.a": ["93.184.216.34"],
      },
    },
  },
  {
    _source: {
      layers: {
        "frame.number": ["2"],
        "frame.protocols": ["eth:ethertype:ip:tcp:tls"],
        "ip.src": ["192.168.1.100"],
        "ip.dst": ["93.184.216.34"],
        "tls.handshake.extensions_server_name": ["api.example.com"],
      },
    },
  },
  {
    _source: {
      layers: {
        "frame.number": ["3"],
        "frame.protocols": ["eth:ethertype:ip:tcp:http"],
        "ip.src": ["192.168.1.100"],
        "ip.dst": ["93.184.216.34"],
        "http.request.full_uri": ["http://api.example.com/v1/data"],
      },
    },
  },
]);

const writeStubTools = async (
  root: string,
  options: { readonly failCapinfos?: boolean } = {},
): Promise<{ tshark: string; capinfos: string }> => {
  const tshark = join(root, "tshark");
  const capinfos = join(root, "capinfos");
  await writeFile(
    tshark,
    `#!/bin/sh
if [ "$1" = "--version" ]; then printf 'TShark (Wireshark) 4.6.6-stub\\n'; exit 0; fi
[ "$1" = "-n" ] && [ "$2" = "-r" ] && [ "$4" = "-T" ] && [ "$5" = "json" ] || exit 2
printf '%s' '${TSHARK_JSON.replace(/'/gu, "'\\''")}'
exit 0
`,
    { mode: 0o755 },
  );
  await writeFile(
    capinfos,
    `#!/bin/sh
if [ "$1" = "--version" ]; then printf 'Capinfos (Wireshark) 4.6.6-stub\\n'; exit 0; fi
[ "$1" = "-M" ] && [ "$2" = "--" ] && [ "$#" = "3" ] || exit 2
if [ "${String(options.failCapinfos === true)}" = "true" ]; then
  printf 'capinfos: The file is not a capture file' >&2; exit 1
fi
printf '%s\\n' '${CAPINFOS_OUTPUT.replace(/'/gu, "'\\''")}'
exit 0
`,
    { mode: 0o755 },
  );
  await chmod(tshark, 0o755);
  await chmod(capinfos, 0o755);
  return { tshark, capinfos };
};

const providerWith = async (options: { failCapinfos?: boolean } = {}) => {
  const root = await createTestTempDirectory("rea-pcap-");
  const { tshark, capinfos } = await writeStubTools(root, options);
  const provider = new PcapProvider({
    environment: { REA_TSHARK_COMMAND: tshark, REA_CAPINFOS_COMMAND: capinfos },
  });
  onTestFinished(() => provider.close());
  return {
    provider,
    root,
  };
};

const evidenceResult = async (
  provider: PcapProvider,
  request: PcapRequest,
): Promise<Record<string, unknown>> => {
  const result = await provider.execute(request);
  if (!result.ok) throw new Error(result.error.message);
  return pcapResultSchemas[request.operation].parse(result.value.result);
};

const captureFixture = async (root: string): Promise<string> => {
  const path = join(root, "capture.pcap");
  await writeFile(path, Buffer.from("pcap-fixture-bytes"));
  return path;
};

it("inspects both tools without reading a capture", async () => {
  const { provider } = await providerWith();
  const result = await evidenceResult(provider, {
    operation: "inspect_pcap_client",
    input: {},
  });
  expect(result.client).toMatchObject({
    tshark_source: "environment",
    tshark_version: "TShark (Wireshark) 4.6.6-stub",
    capinfos_source: "environment",
    capinfos_version: "Capinfos (Wireshark) 4.6.6-stub",
  });
});

it("inspects a capture with endpoints, DNS, TLS SNI, and HTTP", async () => {
  const { provider, root } = await providerWith();
  const path = await captureFixture(root);
  const result = await evidenceResult(provider, {
    operation: "inspect_pcap_capture",
    input: { path },
  });
  expect(result.target).toMatchObject({
    path,
    bytes: 18,
    sha256: createHash("sha256").update("pcap-fixture-bytes").digest("hex"),
  });
  expect(result.file_type).toBe("Wireshark/tcpdump/... - pcap");
  expect(result.packet_count).toBe(3);
  expect(result.endpoints).toEqual(
    expect.arrayContaining([
      { address: "192.168.1.100", port: null, packet_count: 3 },
      { address: "8.8.8.8", port: null, packet_count: 1 },
    ]),
  );
  expect(result.dns_queries).toEqual([
    {
      query: "api.example.com",
      response_addresses: ["93.184.216.34"],
      response_address_count: 1,
    },
  ]);
  expect(result.tls_sni_values).toEqual(["api.example.com"]);
  expect(result.http_request_uris).toEqual(["http://api.example.com/v1/data"]);
  expect(result.coverage).toBe("complete");
});

it("reports a non-capture file as unsupported", async () => {
  const { provider, root } = await providerWith({ failCapinfos: true });
  const failPath = join(root, "fail.pcap");
  await writeFile(failPath, "not a capture file");
  const result = await provider.execute({
    operation: "inspect_pcap_capture",
    input: { path: failPath },
  });
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(projectAnalysisError(result.error)).toMatchObject({
    code: "unsupported_target",
  });
});

it("reports a missing tshark binary as a capability gap", async () => {
  const provider = new PcapProvider({
    environment: { REA_TSHARK_COMMAND: "/nonexistent/tshark" },
  });
  expect(await provider.inspectAvailability()).toMatchObject({
    status: "unavailable",
    code: "executable_missing",
  });
});

it("rejects a capture that is not a readable file", async () => {
  const { provider } = await providerWith();
  const result = await provider.execute({
    operation: "inspect_pcap_capture",
    input: { path: "/nonexistent/capture.pcap" },
  });
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(projectAnalysisError(result.error)).toMatchObject({
    code: "invalid_request",
  });
});

it("cancels before spawning anything", async () => {
  const { provider, root } = await providerWith();
  await writeFile(join(root, "spawned"), "");
  const controller = new AbortController();
  controller.abort();
  const result = await provider.execute(
    {
      operation: "inspect_pcap_capture",
      input: { path: "/some/capture.pcap" },
    },
    { signal: controller.signal },
  );
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(projectAnalysisError(result.error)).toMatchObject({
    code: "cancelled",
  });
});

it("reports relative configuration and missing capinfos as capability gaps", async () => {
  const root = await createTestTempDirectory("rea-pcap-config-");
  const { tshark } = await writeStubTools(root);
  for (const environment of [
    { REA_TSHARK_COMMAND: "relative/tshark" },
    {
      REA_TSHARK_COMMAND: tshark,
      REA_CAPINFOS_COMMAND: join(root, "missing-capinfos"),
    },
  ]) {
    const provider = new PcapProvider({ environment });
    onTestFinished(() => provider.close());
    expect((await provider.inspectAvailability()).status).toBe("unavailable");
    const result = await provider.execute({
      operation: "inspect_pcap_client",
      input: {},
    });
    if (result.ok) throw new Error("expected unavailable tools");
    const projected = projectAnalysisError(result.error);
    expect(projected.code).toBe("capability_unavailable");
    expect(projected.message).toContain(
      "Supply Wireshark 4.x tshark and capinfos",
    );
  }
});

it("names the prlimit selection when the Linux limiter is unusable", async () => {
  const root = await createTestTempDirectory("rea-pcap-prlimit-");
  const tools = await writeStubTools(root);
  const provider = new PcapProvider({
    environment: {
      REA_TSHARK_COMMAND: tools.tshark,
      REA_CAPINFOS_COMMAND: tools.capinfos,
      REA_TSHARK_PRLIMIT_COMMAND: "relative/prlimit",
    },
  });
  onTestFinished(() => provider.close());
  const result = await provider.execute({
    operation: "inspect_pcap_capture",
    input: { path: "/not-opened/capture.pcap" },
  });
  if (result.ok) throw new Error("expected an unusable limiter");
  const projected = projectAnalysisError(result.error);
  expect(projected.code).toBe("capability_unavailable");
  expect(projected.message).toContain(
    "(REA_TSHARK_PRLIMIT_COMMAND must be absolute.) Check that REA_TSHARK_PRLIMIT_COMMAND",
  );
});

const nodeTool = async (
  root: string,
  name: string,
  body: string,
): Promise<string> => {
  const path = join(root, name);
  await writeFile(
    path,
    `#!/usr/bin/env -S ${process.execPath} --jitless --max-old-space-size=64\nconst fs = require('node:fs'); const crypto = require('node:crypto');\n${body}\n`,
    { mode: 0o755 },
  );
  return path;
};
const versionProbe =
  "if (process.argv[2] === '--version') { console.log((process.argv[1].includes('capinfos') ? 'Capinfos' : 'TShark') + ' (Wireshark) 4.6.6-test'); process.exit(0); }";

it("refuses observations whose owned snapshot changed during dissection", async () => {
  const root = await createTestTempDirectory("rea-pcap-mutated-");
  const { capinfos } = await writeStubTools(root);
  const path = await captureFixture(root);
  const before = await readFile(path);
  const tshark = await nodeTool(
    root,
    "tshark.cjs",
    `${versionProbe}
const selected = process.argv[process.argv.indexOf('-r') + 1];
fs.chmodSync(selected, 0o600); fs.writeFileSync(selected, 'changed private snapshot');
console.log(${JSON.stringify(TSHARK_JSON)});`,
  );
  const provider = new PcapProvider({
    environment: { REA_TSHARK_COMMAND: tshark, REA_CAPINFOS_COMMAND: capinfos },
  });
  onTestFinished(() => provider.close());
  const result = await provider.execute({
    operation: "inspect_pcap_capture",
    input: { path },
  });
  expect(result.ok).toBe(false);
  if (!result.ok)
    expect(projectAnalysisError(result.error)).toMatchObject({
      code: "artifact_changed",
    });
  expect(await readFile(path)).toEqual(before);
});

it("binds both tools to the snapshot when the original capture changes", async () => {
  const root = await createTestTempDirectory("rea-pcap-identity-");
  const path = join(root, "caller capture.pcap");
  await writeFile(path, "192.0.2.1");
  const capinfos = await nodeTool(
    root,
    "capinfos.cjs",
    `${versionProbe}
const selected = process.argv.at(-1); const bytes = fs.readFileSync(selected);
console.log('File type: pcap\\nFile encapsulation: Raw IP\\nNumber of packets: 1\\nSHA256: ' + crypto.createHash('sha256').update(bytes).digest('hex'));
fs.writeFileSync(${JSON.stringify(path)}, '192.0.2.2');`,
  );
  const tshark = await nodeTool(
    root,
    "tshark.cjs",
    `${versionProbe}
const selected = process.argv[process.argv.indexOf('-r') + 1];
console.log(JSON.stringify([{_source:{layers:{'frame.number':['1'],'frame.protocols':['ip'],'ip.src':[fs.readFileSync(selected,'utf8')]}}}]));`,
  );
  const provider = new PcapProvider({
    environment: { REA_TSHARK_COMMAND: tshark, REA_CAPINFOS_COMMAND: capinfos },
  });
  onTestFinished(() => provider.close());
  const result = await provider.execute({
    operation: "inspect_pcap_capture",
    input: { path },
  });
  if (!result.ok) throw result.error;
  const value = pcapResultSchemas.inspect_pcap_capture.parse(
    result.value.result,
  );
  expect(value.target.sha256).toBe(
    createHash("sha256").update("192.0.2.1").digest("hex"),
  );
  expect(value.endpoints).toEqual([
    { address: "192.0.2.1", port: null, packet_count: 1 },
  ]);
  expect(await readFile(path, "utf8")).toBe("192.0.2.2");
});

it.each(["probe", "capinfos", "tshark"] as const)(
  "preserves in-flight %s cancellation and cleans up",
  async (phase) => {
    const root = await createTestTempDirectory("rea-pcap-cancel-");
    const marker = join(root, "ready");
    const slow = await nodeTool(
      root,
      `slow-${phase}.cjs`,
      `${phase !== "probe" ? versionProbe : ""}
fs.writeFileSync(${JSON.stringify(marker)}, 'ready'); setInterval(() => {}, 1000);`,
    );
    const { capinfos, tshark } = await writeStubTools(root);
    const path = await captureFixture(root);
    const provider = new PcapProvider({
      environment: {
        REA_TSHARK_COMMAND: phase === "capinfos" ? tshark : slow,
        REA_CAPINFOS_COMMAND: phase === "capinfos" ? slow : capinfos,
      },
    });
    onTestFinished(() => provider.close());
    const controller = new AbortController();
    let watcher: ReturnType<typeof watch> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ready = new Promise<void>((resolve, reject) => {
      watcher = watch(root, (_event, name) => {
        if (name === "ready") resolve();
      });
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error("tool did not start"));
      }, 5000);
    });
    try {
      const pending = provider.execute(
        { operation: "inspect_pcap_capture", input: { path } },
        { signal: controller.signal },
      );
      await ready;
      controller.abort(new Error("caller cancellation"));
      const result = await pending;
      if (result.ok) throw new Error("expected cancellation");
      expect(projectAnalysisError(result.error).code).toBe("cancelled");
      await provider.close();
    } finally {
      watcher?.close();
      clearTimeout(timer);
    }
  },
);

it.each(["change", "cancel"] as const)(
  "preserves %s during snapshot acquisition",
  async (action) => {
    const { provider, root } = await providerWith();
    const path = await captureFixture(root);
    const controller = new AbortController();
    const held = await holdFirstFileRead(path);
    onTestFinished(() => {
      vi.restoreAllMocks();
    });
    const pending = provider.execute(
      { operation: "inspect_pcap_capture", input: { path } },
      { signal: controller.signal },
    );
    try {
      await held.firstRead;
      if (action === "cancel") controller.abort();
      else await writeFile(path, "changed source bytes");
    } finally {
      held.release();
    }
    const result = await pending;
    if (result.ok) throw new Error("expected interrupted acquisition");
    expect(result.error._tag).toBe(
      action === "cancel"
        ? "AnalysisCancelledError"
        : "AnalysisArtifactChangedError",
    );
  },
);

it("admits one capture and drains it before close releases resources", async () => {
  const { provider, root } = await providerWith();
  const path = await captureFixture(root);
  const held = await holdFirstFileRead(path);
  onTestFinished(() => {
    vi.restoreAllMocks();
  });
  const pending = provider.execute({
    operation: "inspect_pcap_capture",
    input: { path },
  });
  let closing: Promise<void> | undefined;
  try {
    await held.firstRead;
    const concurrent = await provider.execute({
      operation: "inspect_pcap_capture",
      input: { path },
    });
    expect(concurrent.ok).toBe(false);
    if (!concurrent.ok)
      expect(projectAnalysisError(concurrent.error)).toMatchObject({
        code: "resource_constraint",
        details: { resource: "capacity" },
      });
    let closed = false;
    closing = provider.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
  } finally {
    held.release();
  }
  expect((await pending).ok).toBe(true);
  await closing;
  const afterClose = await provider.execute({
    operation: "inspect_pcap_capture",
    input: { path },
  });
  expect(afterClose.ok).toBe(false);
});

it.each([false, true])(
  "retains failed snapshot cleanup after an analysis failure=%s",
  async (failCapinfos) => {
    const { provider, root } = await providerWith({ failCapinfos });
    const path = await captureFixture(root);
    let retained: PrivateRuntimeRoot | undefined;
    const spy = vi
      .spyOn(PrivateRuntimeRoot.prototype, "close")
      .mockImplementation(function (this: PrivateRuntimeRoot) {
        retained = this;
        return Promise.reject(new Error("controlled cleanup failure"));
      });
    const result = await provider.execute({
      operation: "inspect_pcap_capture",
      input: { path },
    });
    try {
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("Cleanup failure cannot return success");
      expect(projectAnalysisError(result.error)).toMatchObject({
        code: "cleanup_incomplete",
      });
      if (failCapinfos)
        expect(projectAnalysisError(result.error)).toMatchObject({
          details: {
            diagnostics: { primary_error: { code: "unsupported_target" } },
          },
        });
      else
        expect(result.error.partialObservation).toMatchObject({
          operation: "inspect_pcap_capture",
          normalized_result: { packet_count: 3 },
        });
      expect(retained).toBeDefined();
      await expect(provider.close()).rejects.toMatchObject({
        cleanupIncomplete: true,
      });
    } finally {
      spy.mockRestore();
    }
    await provider.close();
    await expect(
      readFile(join(retained!.path, "capture.pcap")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  },
);
