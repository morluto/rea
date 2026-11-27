import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { createCli } from "../../../src/cli.js";
import * as espNvsItemDecoder from "../../../src/domain/firmware/espNvsItemDecoder.js";
import {
  computeNvsItemHeaderCrc,
  espIdfCrc32,
} from "../../../src/domain/firmware/espNvsItemDecoder.js";
import { silentLogger } from "../../../src/logger.js";
import { createServer } from "../../../src/server/createServer.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { createMcpSchemaValidation } from "../../fixtures/mcpSchemaValidation.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const buildActiveNvsPage = (
  namespaceName: string,
  u32Entries: readonly { readonly key: string; readonly value: number }[],
): Buffer => {
  const page = Buffer.alloc(4096, 0xff);
  page.writeUInt32LE(0xffff_fffe, 0);
  page.writeUInt32LE(1, 4);
  page[8] = 0xfe;
  page.writeUInt32LE(espIdfCrc32(page.subarray(4, 28)), 28);

  const markWritten = (slot: number) => {
    const byteIdx = 32 + (slot >>> 2);
    const shift = (slot & 3) * 2;
    page[byteIdx] = page[byteIdx]! & ~(1 << shift);
  };

  // Slot 0: namespace -> id 1
  const s0 = page.subarray(64, 96);
  s0.fill(0xff);
  s0[0] = 0;
  s0[1] = 0x01;
  s0[2] = 1;
  s0[3] = 0xff;
  s0.fill(0, 8, 24);
  Buffer.from(namespaceName, "utf8").copy(s0, 8);
  s0[24] = 1;
  s0.writeUInt32LE(computeNvsItemHeaderCrc(s0), 4);
  markWritten(0);

  u32Entries.forEach(({ key, value }, idx) => {
    const slot = idx + 1;
    const off = 64 + slot * 32;
    const s = page.subarray(off, off + 32);
    s.fill(0xff);
    s[0] = 1;
    s[1] = 0x04;
    s[2] = 1;
    s[3] = 0xff;
    s.fill(0, 8, 24);
    Buffer.from(key, "utf8").copy(s, 8);
    s.writeUInt32LE(value >>> 0, 24);
    s.writeUInt32LE(computeNvsItemHeaderCrc(s), 4);
    markWritten(slot);
  });

  return page;
};

describe("inspect_esp_nvs CLI and MCP parity", () => {
  it("decodes an NVS slice inside a flash dump with CLI and advertised MCP parity", async () => {
    const dir = await createTestTempDirectory("rea-esp-nvs-");
    const flashPath = join(dir, "esp32.bin");
    const prefix = Buffer.alloc(4096, 0xff);
    const page = buildActiveNvsPage("cfg", [{ key: "baud", value: 115200 }]);

    await writeFile(flashPath, Buffer.concat([prefix, page]));

    const session = createTestBinarySession(() => {
      throw new Error("No deep provider should start");
    });
    const server = createServer(
      { kind: "session", session },
      { environment: {}, logger: silentLogger },
    );
    const client = new Client(
      { name: "esp-nvs-test", version: "1" },
      { jsonSchemaValidator: createMcpSchemaValidation() },
    );
    onTestFinished(async () => {
      await client.close();
      await server.close();
      await session.close();
    });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const mcpRes = await client.callTool({
      name: "inspect_esp_nvs",
      arguments: {
        path: flashPath,
        partition_offset: 4096,
        partition_bytes: 4096,
      },
    });
    expect(mcpRes.isError).not.toBe(true);
    const mcpStructured = mcpRes.structuredContent as {
      parameters: Record<string, unknown>;
      normalized_result: {
        entries: {
          namespace: string | null;
          key: string;
          value_integer: string | null;
        }[];
      };
    };
    expect(mcpStructured.parameters).toEqual({
      path: flashPath,
      partition_offset: 4096,
      partition_bytes: 4096,
    });
    expect(mcpStructured.normalized_result.entries).toMatchObject([
      { namespace: "cfg", key: "baud", value_integer: "115200" },
    ]);

    let cliStdout = "";
    let cliExitCode = 0;
    await createCli({}).serve(
      [
        "inspect-esp-nvs",
        flashPath,
        "--partition-offset",
        "4096",
        "--partition-bytes",
        "4096",
        "--format",
        "json",
      ],
      {
        env: {},
        exit: (code) => {
          cliExitCode = code;
        },
        stdout: (chunk) => {
          cliStdout += chunk;
        },
      },
    );
    expect(cliExitCode).toBe(0);
    const cliParsed = JSON.parse(cliStdout) as {
      normalized_result: typeof mcpStructured.normalized_result;
    };
    expect(cliParsed.normalized_result).toEqual(
      mcpStructured.normalized_result,
    );
  });

  it("retains complete NVS entries for inspect_analysis_view and --evidence-output when max_entries or summary bounds inline output", async () => {
    const dir = await createTestTempDirectory("rea-esp-nvs-retained-");
    const nvsPath = join(dir, "settings.bin");
    const bundlePath = join(dir, "settings.evidence.json");
    const page = buildActiveNvsPage("sys", [
      { key: "k0", value: 10 },
      { key: "k1", value: 20 },
      { key: "k2", value: 30 },
      { key: "k3", value: 40 },
      { key: "k4", value: 50 },
    ]);
    await writeFile(nvsPath, page);

    const session = createTestBinarySession(() => {
      throw new Error("No deep provider should start");
    });
    const server = createServer(
      { kind: "session", session },
      { environment: {}, logger: silentLogger },
    );
    const client = new Client(
      { name: "esp-nvs-retained-test", version: "1" },
      { jsonSchemaValidator: createMcpSchemaValidation() },
    );
    onTestFinished(async () => {
      await client.close();
      await server.close();
      await session.close();
    });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    // 1. Inline max_entries=2 bounds inline delivery while retaining all 5 entries in parent Evidence.
    const boundedRes = await client.callTool({
      name: "inspect_esp_nvs",
      arguments: { path: nvsPath, max_entries: 2 },
    });
    expect(boundedRes.isError).not.toBe(true);
    const boundedEvidence = boundedRes.structuredContent as {
      evidence_links: string[];
      normalized_result: {
        coverage: {
          status: string;
          retained_entries: number;
          omitted_entries: number;
        };
        entries: { key: string; value_integer: string | null }[];
      };
    };
    expect(boundedEvidence.normalized_result.coverage).toMatchObject({
      status: "partial",
      retained_entries: 2,
      omitted_entries: 3,
    });
    expect(boundedEvidence.normalized_result.entries.map((e) => e.key)).toEqual(
      ["k0", "k1"],
    );
    const parentId = boundedEvidence.evidence_links[0];
    expect(parentId).toMatch(/^ev_[0-9a-f]{64}$/u);

    // Recover omitted entries via inspect_analysis_view kind "esp-nvs"
    const viewPageRes = await client.callTool({
      name: "inspect_analysis_view",
      arguments: {
        source: { kind: "retained-evidence", evidence_id: parentId },
        view: { kind: "esp-nvs", collection: "entries", offset: 2, limit: 10 },
      },
    });
    expect(viewPageRes.isError).not.toBe(true);
    const viewPage = viewPageRes.structuredContent as {
      normalized_result: {
        items: {
          key: string;
          value_integer: string | null;
          source_index: number;
        }[];
      };
    };
    expect(viewPage.normalized_result.items).toMatchObject([
      { key: "k2", value_integer: "30", source_index: 2 },
      { key: "k3", value_integer: "40", source_index: 3 },
      { key: "k4", value_integer: "50", source_index: 4 },
    ]);

    // Recover complete parent Evidence via inspect_analysis_view kind "evidence-json"
    const jsonViewRes = await client.callTool({
      name: "inspect_analysis_view",
      arguments: {
        source: { kind: "retained-evidence", evidence_id: parentId },
        view: { kind: "evidence-json" },
      },
    });
    expect(jsonViewRes.isError).not.toBe(true);
    const jsonView = jsonViewRes.structuredContent as {
      normalized_result: { text: string; coverage: { exhausted: boolean } };
    };
    expect(jsonView.normalized_result.coverage.exhausted).toBe(true);
    const parsedParent = JSON.parse(jsonView.normalized_result.text) as {
      normalized_result: { entries: { key: string }[] };
    };
    expect(parsedParent.normalized_result.entries.map((e) => e.key)).toEqual([
      "k0",
      "k1",
      "k2",
      "k3",
      "k4",
    ]);

    // 2. Summary detail also retains the complete 5-entry Evidence in the session.
    const summaryRes = await client.callTool({
      name: "inspect_esp_nvs",
      arguments: { path: nvsPath, detail: "summary" },
    });
    expect(summaryRes.isError).not.toBe(true);
    const summaryEvidence = summaryRes.structuredContent as {
      normalized_result: {
        kind: string;
        parent_evidence_id: string;
        summary: { entry_count: number };
      };
    };
    expect(summaryEvidence.normalized_result).toMatchObject({
      kind: "summary",
      parent_evidence_id: parentId,
      summary: { entry_count: 5 },
    });

    // 3. CLI --max-entries 2 --evidence_output preserves complete 5-entry Evidence in the bundle.
    let cliStdout = "";
    let cliExitCode = 0;
    await createCli({}).serve(
      [
        "inspect-esp-nvs",
        nvsPath,
        "--max-entries",
        "2",
        "--evidence_output",
        bundlePath,
        "--format",
        "json",
      ],
      {
        env: {},
        exit: (code) => {
          cliExitCode = code;
        },
        stdout: (chunk) => {
          cliStdout += chunk;
        },
      },
    );
    expect(cliExitCode).toBe(0);
    const cliDelivered = JSON.parse(cliStdout) as {
      normalized_result: { entries: { key: string }[] };
    };
    expect(cliDelivered.normalized_result.entries.map((e) => e.key)).toEqual([
      "k0",
      "k1",
    ]);
    const exportedBundle = JSON.parse(await readFile(bundlePath, "utf8")) as {
      records: {
        evidence_id: string;
        normalized_result: { entries: { key: string }[] };
      }[];
    };
    const exportedComplete = exportedBundle.records.find(
      (r) => r.evidence_id === parentId,
    );
    expect(
      exportedComplete?.normalized_result.entries.map((e) => e.key),
    ).toEqual(["k0", "k1", "k2", "k3", "k4"]);

    // 4. CLI --detail summary --max-entries 2 --evidence_output keeps all 5 entries in both summary and bundle.
    const summaryBundlePath = join(dir, "settings-summary.evidence.json");
    let summaryCliStdout = "";
    let summaryCliExitCode = 0;
    await createCli({}).serve(
      [
        "inspect-esp-nvs",
        nvsPath,
        "--detail",
        "summary",
        "--max-entries",
        "2",
        "--evidence_output",
        summaryBundlePath,
        "--format",
        "json",
      ],
      {
        env: {},
        exit: (code) => {
          summaryCliExitCode = code;
        },
        stdout: (chunk) => {
          summaryCliStdout += chunk;
        },
      },
    );
    expect(summaryCliExitCode).toBe(0);
    const summaryCliParsed = JSON.parse(summaryCliStdout) as {
      summary: {
        normalized_result: {
          kind: string;
          parent_evidence_id: string;
          summary: { entry_count: number };
        };
      };
    };
    expect(summaryCliParsed.summary.normalized_result).toMatchObject({
      kind: "summary",
      parent_evidence_id: parentId,
      summary: { entry_count: 5 },
    });
    const exportedSummaryBundle = JSON.parse(
      await readFile(summaryBundlePath, "utf8"),
    ) as {
      records: {
        evidence_id: string;
        normalized_result: { entries: { key: string }[] };
      }[];
    };
    expect(
      exportedSummaryBundle.records
        .find((r) => r.evidence_id === parentId)
        ?.normalized_result.entries.map((e) => e.key),
    ).toEqual(["k0", "k1", "k2", "k3", "k4"]);

    // 5. Mid-decode AbortSignal cancellation interrupts a multi-page partition before later batches run.
    const largePath = join(dir, "many-pages.bin");
    await writeFile(
      largePath,
      Buffer.concat(
        Array.from({ length: 32 }, () =>
          buildActiveNvsPage("sys", [{ key: "k0", value: 1 }]),
        ),
      ),
    );
    const { createEspNvsService } =
      await import("../../../src/composition/binaryDiagnostics/espNvs.js");
    const abortService = createEspNvsService();
    onTestFinished(() => abortService.close());
    const midAbort = new AbortController();
    let decodedSlots = 0;
    const realDecode = espNvsItemDecoder.decodeWrittenNvsSlot;
    const decodeSpy = vi
      .spyOn(espNvsItemDecoder, "decodeWrittenNvsSlot")
      .mockImplementation((ctx) => {
        decodedSlots += 1;
        if (decodedSlots === 1) {
          setImmediate(() => midAbort.abort("cancel-mid-decode"));
        }
        return realDecode(ctx);
      });
    onTestFinished(() => decodeSpy.mockRestore());

    const cancelledRes = await abortService.inspect(
      { path: largePath },
      { signal: midAbort.signal },
    );
    decodeSpy.mockRestore();
    expect(cancelledRes.ok).toBe(false);
    if (!cancelledRes.ok) {
      expect(cancelledRes.error._tag).toBe("AnalysisCancelledError");
    }
    // 32 pages * 2 written slots/page = 64 slots total; cooperative yield after
    // 16 pages (32 slots) lets setImmediate abort before pages 16..31 decode.
    expect(decodedSlots).toBe(32);

    // 6. Explicit partition_bytes extending past EOF fails closed instead of silently clamping to complete.
    const shortSelectionRes = await client.callTool({
      name: "inspect_esp_nvs",
      arguments: {
        path: nvsPath,
        partition_offset: 0,
        partition_bytes: 12288,
      },
    });
    expect(shortSelectionRes.isError).toBe(true);
    const errorBlock = shortSelectionRes.content[0] as {
      type: "text";
      text: string;
    };
    expect(errorBlock.text).toContain("partition_bytes");
    expect(errorBlock.text).toContain("12288");

    // 7. Dense decoded representations refuse with max_decoded_bytes adjustable_budget recovery.
    const decodedLimitRes = await client.callTool({
      name: "inspect_esp_nvs",
      arguments: {
        path: nvsPath,
        max_decoded_bytes: 1024,
      },
    });
    expect(decodedLimitRes.isError).toBe(true);
    const decodedLimitErr = JSON.parse(
      (decodedLimitRes.content[0] as { type: "text"; text: string }).text,
    ) as Record<string, unknown>;
    expect(decodedLimitErr).toMatchObject({
      error: {
        code: "resource_constraint",
        details: {
          limit: {
            control_kind: "parameter",
            parameter: "max_decoded_bytes",
            effective_value: 1024,
          },
          related_parameters: ["partition_offset", "partition_bytes"],
          refusal: {
            kind: "adjustable_budget",
            control: "max_decoded_bytes",
            effective_value: 1024,
          },
        },
      },
    });
  });
});
