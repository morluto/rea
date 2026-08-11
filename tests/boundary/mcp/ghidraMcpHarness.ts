import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { composeBinarySession } from "../../../src/application/BinarySessionComposition.js";
import type { BinarySession } from "../../../src/application/BinarySession.js";
import { AnalysisProviderRegistry } from "../../../src/application/AnalysisProviderRegistry.js";
import { SessionProviderRouter } from "../../../src/application/SessionProviderRouter.js";
import { parseConfig } from "../../../src/config.js";
import type { JsonValue } from "../../../src/domain/jsonValue.js";
import { ok } from "../../../src/domain/result.js";
import type { GhidraInstallationHost } from "../../../src/ghidra/GhidraInstallation.js";
import type { GhidraOperation } from "../../../src/ghidra/GhidraClient.js";
import {
  GhidraProvider,
  type GhidraProviderClientFactory,
} from "../../../src/ghidra/GhidraProvider.js";
import { GHIDRA_SESSION_CAPABILITIES } from "../../../src/ghidra/GhidraSessionValues.js";
import { silentLogger } from "../../../src/logger.js";
import { createServer } from "../../../src/server/createServer.js";
import {
  ghidraBounded,
  ghidraFunctionClassification,
  ghidraFunctionDossier,
  ghidraFunctionIdentity,
  ghidraReferenceEdge,
} from "../../../src/domain/hopperValues.fixture.js";

const INSTALL = "/opt/ghidra_12.1.2_PUBLIC";

export const connectGhidraMcp = async (name: string) => {
  const calls: GhidraOperation[] = [];
  const factory: GhidraProviderClientFactory = (options) => ({
    start: () =>
      Promise.resolve(
        ok(sessionInfo(options.profileDigest, options.targetSha256)),
      ),
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
  const session = composeBinarySession(
    SessionProviderRouter.selectable(
      new AnalysisProviderRegistry([provider]),
      [],
    ),
  );
  const server = createServer(session, session, { logger: silentLogger });
  const mcp = new Client({ name, version: "1.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const close = async () => {
    await Promise.allSettled([mcp.close(), server.close()]);
    await session.close();
  };
  try {
    await server.connect(serverTransport);
    await mcp.connect(clientTransport);
    const opened = await mcp.callTool({
      name: "open_binary",
      arguments: { path: process.execPath },
    });
    if (opened.isError === true)
      throw new Error("The Ghidra MCP harness could not open its target");
  } catch (cause: unknown) {
    await close();
    throw cause;
  }
  return {
    calls,
    mcp,
    session,
    close,
  };
};

export const sessionEvidence = (session: BinarySession, value: unknown) => {
  if (
    typeof value !== "object" ||
    value === null ||
    !("evidence_id" in value) ||
    typeof value.evidence_id !== "string"
  )
    throw new TypeError(
      `Missing compact Evidence ID: ${JSON.stringify(value)}`,
    );
  const evidence = session.evidenceById(value.evidence_id);
  if (evidence === undefined) throw new TypeError("Missing session Evidence");
  return evidence;
};

const installationHost = (): GhidraInstallationHost => ({
  platform: "linux",
  architecture: "x64",
  readText: () => "application.version=12.1.2\n",
  executable: () => true,
  probeJava: () => ({
    version: "21.0.11",
    major: 21,
    home: "/usr/lib/jvm/jdk-21",
    bits: 64,
    runtime: "jdk",
  }),
});

const sessionInfo = (profileDigest: string, targetSha256: string) => ({
  name: "REA Ghidra bridge" as const,
  bridge_version: 6 as const,
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
    sha256: targetSha256,
  },
});

type GhidraResultBuilder = (
  input: Readonly<Record<string, JsonValue>>,
  limit: number,
) => JsonValue;

const resultBuilders = new Map<GhidraOperation, GhidraResultBuilder>([
  ["list_documents", () => ["fixture"]],
  [
    "list_procedures",
    (_input, limit) =>
      page(
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
      ),
  ],
  [
    "list_strings",
    (_input, limit) =>
      page(
        [
          stringItem("0x402000", "inventory fixture"),
          stringItem("0x402020", "external fixture"),
        ],
        limit,
      ),
  ],
  [
    "list_segments",
    () => [
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
    ],
  ],
  [
    "list_names",
    (_input, limit) =>
      page(
        [
          {
            address: "0x401000",
            value: "fixture_main",
            value_truncated: false,
            symbol: {
              primary: true,
              dynamic: false,
              external: false,
              type: "function",
              source: "user_defined",
            },
          },
        ],
        limit,
      ),
  ],
  ["search_procedures", (_input, limit) => page([], limit)],
  ["search_strings", (_input, limit) => page([], limit)],
  ["address_name", () => "fixture_main"],
  ["procedure_address", () => "0x401000"],
  [
    "resolve_containing_procedure",
    () => ({
      query_address: "0x401001",
      found: true,
      procedure: ghidraFunctionIdentity(),
    }),
  ],
  ["procedure_assembly", () => "0x401000: CALL 0x401020\n0x401005: RET"],
  ["procedure_callees", () => []],
  ["procedure_callers", () => []],
  [
    "procedure_info",
    () => ({
      name: "fixture_main",
      entrypoint: "0x401000",
      basicblock_count: 1,
      length: 6,
      signature: "int fixture_main(void)",
      locals: [],
      classification: ghidraFunctionClassification(),
    }),
  ],
  ["procedure_pseudo_code", () => "int fixture_main(void) { return 42; }"],
  [
    "read_function_instructions",
    () => ({
      procedure: ghidraFunctionIdentity(),
      instructions: ghidraBounded(["0x401000: CALL 0x401020", "0x401005: RET"]),
      instructions_scanned: 2,
      instruction_scan_truncated: false,
      limitations: ["Ghidra-specific instruction text."],
    }),
  ],
  [
    "procedure_references",
    (input, _limit) => ({
      procedure: ghidraFunctionIdentity(),
      direction: input.direction ?? "outgoing",
      references: ghidraBounded([ghidraReferenceEdge()]),
      instructions_scanned: 2,
      instruction_scan_truncated: false,
    }),
  ],
  ["xrefs", () => ["0x401001"]],
  [
    "analyze_function",
    (input, _limit) =>
      ghidraFunctionDossier(
        input.include_assembly === true,
        input.procedure === "fixture_truncated",
      ),
  ],
]);

const resultFor = (
  operation: GhidraOperation,
  input: Readonly<Record<string, JsonValue>>,
): JsonValue => {
  const limit = typeof input.limit === "number" ? input.limit : 100;
  const builder = resultBuilders.get(operation);
  if (builder === undefined)
    throw new TypeError(`Unexpected Ghidra operation: ${operation}`);
  return builder(input, limit);
};

const page = (items: readonly JsonValue[], limit: number): JsonValue => ({
  items: items.slice(0, limit),
  offset: 0,
  limit,
  total: items.length,
  next_offset: items.length > limit ? limit : null,
  has_more: items.length > limit,
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
