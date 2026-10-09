import { expect } from "vitest";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { composeBinarySession } from "../../../src/application/binary/BinarySessionComposition.js";
import type { BinarySession } from "../../../src/application/binary/BinarySession.js";
import { AnalysisProviderRegistry } from "../../../src/application/binary/AnalysisProviderRegistry.js";
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
  ghidraFunctionClassification,
  ghidraFunctionDossier,
  ghidraFunctionIdentity,
  ghidraReferenceEdge,
} from "../../../src/domain/ghidraValues.fixture.js";

const INSTALL = "/opt/ghidra_12.1.4_PUBLIC";

export const connectGhidraMcp = async (
  name: string,
  execute?: ReturnType<GhidraProviderClientFactory>["callTool"],
) => {
  const calls: GhidraOperation[] = [];
  const factory: GhidraProviderClientFactory = (options) => ({
    start: () =>
      Promise.resolve(
        ok(sessionInfo(options.profileDigest, options.targetSha256)),
      ),
    callTool: (operation, input, options) => {
      calls.push(operation);
      if (execute !== undefined) return execute(operation, input, options);
      return Promise.resolve(ok(resultFor(operation, input)));
    },
    close: () => Promise.resolve(ok(null)),
  });
  const config = parseConfig({ GHIDRA_INSTALL_DIR: INSTALL });
  if (!config.ok) throw config.error;
  const provider = new GhidraProvider(
    config.value,
    silentLogger,
    {},
    installationHost(),
    factory,
  );
  const session = composeBinarySession(
    new AnalysisProviderRegistry([provider]),
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
      throw new Error(
        `The Ghidra MCP harness could not open its target: ${JSON.stringify(opened)}`,
      );
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
  const evidence = parseEvidence(value);
  expect(session.evidenceById(evidence.evidence_id)).toEqual(evidence);
  return evidence;
};

const installationHost = (): GhidraInstallationHost => ({
  platform: "linux",
  architecture: "x64",
  readText: () => "application.version=12.1.4\n",
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
  run_id: "11111111-1111-4111-8111-111111111111",
  profile_digest: profileDigest,
  provider: { id: "ghidra" as const, version: "12.1.4" },
  read_only: false as const,
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
    () => [
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
  ],
  [
    "list_strings",
    () => [
      stringItem("0x402000", "inventory fixture"),
      stringItem("0x402020", "external fixture"),
    ],
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
    () => [
      {
        address: "0x401000",
        value: "fixture_main",
        symbol: {
          primary: true,
          dynamic: false,
          external: false,
          type: "function",
          source: "user_defined",
        },
      },
    ],
  ],
  ["search_procedures", () => []],
  ["search_strings", () => []],
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
      instructions: ["0x401000: CALL 0x401020", "0x401005: RET"],
      limitations: ["Ghidra-specific instruction text."],
    }),
  ],
  [
    "procedure_references",
    (input, _limit) => ({
      procedure: ghidraFunctionIdentity(),
      direction: input.direction ?? "outgoing",
      references: [ghidraReferenceEdge()],
    }),
  ],
  ["xrefs", () => ["0x401001"]],
  [
    "analyze_function",
    (input) => ghidraFunctionDossier(input.include_assembly === true),
  ],
]);

const resultFor = (
  operation: GhidraOperation,
  input: Readonly<Record<string, JsonValue>>,
): JsonValue => {
  const builder = resultBuilders.get(operation);
  if (builder === undefined)
    throw new TypeError(`Unexpected Ghidra operation: ${operation}`);
  return builder(input, typeof input.limit === "number" ? input.limit : 100);
};

const stringItem = (address: string, value: string): JsonValue => ({
  address,
  value,
  string: {
    encoding: "UTF-8",
    termination: "present_or_not_required",
    byte_length: value.length + 1,
  },
});
