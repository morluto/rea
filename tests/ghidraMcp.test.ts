import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";

import { BinarySession } from "../src/application/BinarySession.js";
import { EnhancedTools } from "../src/application/EnhancedTools.js";
import { AnalysisProviderRegistry } from "../src/application/AnalysisProviderRegistry.js";
import { SessionProviderRouter } from "../src/application/SessionProviderRouter.js";
import { parseConfig } from "../src/config.js";
import { parseEvidence } from "../src/domain/evidence.js";
import type { JsonValue } from "../src/domain/jsonValue.js";
import { ok } from "../src/domain/result.js";
import type { GhidraInstallationHost } from "../src/ghidra/GhidraInstallation.js";
import type { GhidraInventoryOperation } from "../src/ghidra/GhidraInventoryValues.js";
import {
  GhidraProvider,
  type GhidraProviderClientFactory,
} from "../src/ghidra/GhidraProvider.js";
import { GHIDRA_SESSION_CAPABILITIES } from "../src/ghidra/GhidraSessionValues.js";
import { silentLogger } from "../src/logger.js";
import { createServer } from "../src/server/createServer.js";

const INSTALL = "/opt/ghidra_12.1.2_PUBLIC";

describe("Ghidra MCP and shared CLI composition", () => {
  it("preserves provider evidence, composed parity, and capability routing", async () => {
    const calls: GhidraInventoryOperation[] = [];
    const factory: GhidraProviderClientFactory = (options) => ({
      start: () => Promise.resolve(ok(sessionInfo(options.profileDigest))),
      callTool: (operation, input) => {
        calls.push(operation);
        return Promise.resolve(ok(resultFor(operation, input)));
      },
      close: () => Promise.resolve(),
    });
    const config = parseConfig({ GHIDRA_INSTALL_DIR: INSTALL });
    if (!config.ok) throw config.error;
    const provider = new GhidraProvider(
      config.value,
      silentLogger,
      installationHost(),
      factory,
    );
    const session = new BinarySession(
      SessionProviderRouter.selectable(
        new AnalysisProviderRegistry([provider]),
        [],
      ),
    );
    const server = createServer(session, session, { logger: silentLogger });
    const mcp = new Client({ name: "ghidra-parity", version: "1.0.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    try {
      await server.connect(serverTransport);
      await mcp.connect(clientTransport);
      const opened = await mcp.callTool({
        name: "open_binary",
        arguments: { path: process.execPath },
      });
      expect(opened.isError).not.toBe(true);

      const listed = parseEvidence(
        (
          await mcp.callTool({
            name: "list_procedures",
            arguments: {},
          })
        ).structuredContent,
      );
      expect(listed).toMatchObject({
        operation: "list_procedures",
        provider: { id: "ghidra", name: "Ghidra", version: "12.1.2" },
        analysis_profile: {
          provider: { id: "ghidra", version: "12.1.2" },
          parameters: {
            import_mode: "ephemeral-read-only",
            analyzer_preset: "ghidra-default",
          },
        },
        normalized_result: {
          items: [
            {
              address: "0x401000",
              value: "fixture_main",
              procedure: {
                external: false,
                thunk: false,
                thunk_target: null,
              },
            },
          ],
          total: 1,
        },
        raw_result: {
          items: [{ value_truncated: false }],
        },
      });

      const mcpOverview = parseEvidence(
        (
          await mcp.callTool({
            name: "binary_overview",
            arguments: { detail: "detailed", limit: 5 },
          })
        ).structuredContent,
      );
      const directOverview = await new EnhancedTools(session).execute(
        "binary_overview",
        { detail: "detailed", limit: 5 },
      );
      expect(directOverview.ok).toBe(true);
      if (!directOverview.ok) return;
      expect(mcpOverview.normalized_result).toEqual(directOverview.value);
      expect(mcpOverview).toMatchObject({
        provider: { id: "rea-workflow" },
        confidence: "derived",
        normalized_result: {
          document: "fixture",
          segment_count: 1,
          procedure_count: 1,
          string_count: 2,
          segments: [{ name: ".text", length: 256 }],
        },
      });

      const unsupported = await mcp.callTool({
        name: "set_comment",
        arguments: { address: "0x401000", comment: "not allowed" },
      });
      expect(unsupported.isError).toBe(true);
      expect(unsupported.structuredContent).toMatchObject({
        error: { code: "capability_unavailable" },
      });
      expect(calls).not.toContain("set_comment");

      const status = await mcp.callTool({
        name: "binary_session",
        arguments: {},
      });
      expect(status.structuredContent).toMatchObject({
        result: {
          open: true,
          analysis_provider_binding: {
            provider: { id: "ghidra", version: "12.1.2" },
          },
          tool_availability: expect.arrayContaining([
            expect.objectContaining({
              name: "binary_overview",
              available: true,
            }),
            expect.objectContaining({ name: "swift_classes", available: true }),
            expect.objectContaining({
              name: "get_objc_classes",
              available: true,
            }),
            expect.objectContaining({
              name: "batch_decompile",
              available: false,
              reason: "provider_missing",
            }),
            expect.objectContaining({
              name: "trace_feature",
              available: false,
              reason: "provider_missing",
            }),
          ]),
        },
      });
    } finally {
      await Promise.allSettled([mcp.close(), server.close()]);
      await session.close();
    }
  });
});

const installationHost = (): GhidraInstallationHost => ({
  readText: () => "application.version=12.1.2\n",
  executable: () => true,
  probeJava: () => ({
    version: "21.0.11",
    major: 21,
    home: "/usr/lib/jvm/jdk-21",
    bits: 64,
    jdk: true,
  }),
});

const sessionInfo = (profileDigest: string) => ({
  name: "REA Ghidra bridge" as const,
  bridge_version: 2 as const,
  run_id: "11111111-1111-4111-8111-111111111111",
  profile_digest: profileDigest,
  provider: { id: "ghidra" as const, version: "12.1.2" },
  read_only: true as const,
  analysis_complete: true,
  analysis_timed_out: false,
  capabilities: [...GHIDRA_SESSION_CAPABILITIES],
  target: {
    name: "fixture",
    language_id: "x86:LE:64:default",
    compiler_spec_id: "gcc",
    image_base: "0x400000",
    default_address_space: "ram",
  },
});

const resultFor = (
  operation: GhidraInventoryOperation,
  input: Readonly<Record<string, JsonValue>>,
): JsonValue => {
  const limit = typeof input.limit === "number" ? input.limit : 100;
  switch (operation) {
    case "list_documents":
      return ["fixture"];
    case "list_procedures":
      return page(
        [
          {
            address: "0x401000",
            value: "fixture_main",
            value_truncated: false,
            procedure: {
              external: false,
              thunk: false,
              thunk_target: null,
            },
          },
        ],
        limit,
      );
    case "list_strings":
      return page(
        [
          stringItem("0x402000", "inventory fixture"),
          stringItem("0x402020", "external fixture"),
        ],
        limit,
      );
    case "list_segments":
      return [
        {
          name: ".text",
          start: "0x401000",
          end: "0x401100",
          readable: true,
          writable: false,
          executable: true,
          permissions: { available: true, source: "ghidra-memory-block" },
          provenance: "ghidra-memory-block",
          address_space: "ram",
          image_base: "0x400000",
          initialized: true,
          overlay: false,
          sections: [],
        },
      ];
    case "list_names":
    case "search_procedures":
    case "search_strings":
      return page([], limit);
    case "address_name":
      return "fixture_main";
    case "procedure_address":
      return "0x401000";
    case "resolve_containing_procedure":
      return {
        query_address: "0x401001",
        found: true,
        procedure: { address: "0x401000", name: "fixture_main" },
      };
  }
};

const page = (items: readonly JsonValue[], limit: number): JsonValue => ({
  items: [...items],
  offset: 0,
  limit,
  total: items.length,
  next_offset: null,
  has_more: false,
});

const stringItem = (address: string, value: string): JsonValue => ({
  address,
  value,
  value_truncated: false,
  string: {
    encoding: "UTF-8",
    termination: "present_or_not_required",
    byte_length: value.length + 1,
  },
});
