import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it } from "vitest";

import { INLINE_EVIDENCE_MCP_ENVIRONMENT } from "../../../scripts/lib/mcp-verification-environment.mjs";
import type { DirectAnalysisDependencies } from "../../../src/application/DirectAnalysisDependencies.js";
import { BinarySession } from "../../../src/application/binary/BinarySession.js";
import {
  CLI_COMMAND_REGISTRATIONS,
  CLI_REGISTRATION_ORDER,
} from "../../../src/cli/cliCommandRegistrations.js";
import { createCliShell } from "../../../src/cli/cliShell.js";
import type { ContractCliDescription } from "../../../src/cli/contractCliDescriptionTypes.js";
import { registeredContractDescriptions } from "../../support/cli/commandCli.js";
import { createArtifactBinarySession } from "../../../src/composition/binary.js";
import { bindDirectAnalysis } from "../../../src/composition/directAnalysis.js";
import { parseConfig } from "../../../src/config/parseConfig.js";
import { ARTIFACT_TOOL_CONTRACTS } from "../../../src/contracts/artifactToolContracts.js";
import { ENHANCED_TOOL_CONTRACTS } from "../../../src/contracts/enhancedToolContracts.js";
import { MANAGED_TOOL_CONTRACTS } from "../../../src/contracts/managed/managedToolContracts.js";
import { NATIVE_TOOL_CONTRACTS } from "../../../src/contracts/native/nativeToolContracts.js";
import { OFFICIAL_TOOL_CONTRACTS } from "../../../src/contracts/officialToolContracts.js";
import { TOOL_CONTRACTS } from "../../../src/contracts/toolContracts.js";
import type { JsonValue } from "../../../src/domain/jsonValue.js";
import { ok } from "../../../src/domain/result.js";
import { createAnalysisExecution } from "../../../src/ports/AnalysisProvider.js";
import { createServer } from "../../../src/server/createServer.js";
import { writeOrderedZip } from "../../fixtures/artifactEntryOrder.js";
import { createTestProviderRouter } from "../../fixtures/binarySession.js";
import {
  minimalContractInput,
  minimalContractResult,
} from "../../fixtures/minimalContractResult.js";
import { minimalMachoImage } from "../../fixtures/nativeHeaders.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { serveInProcessCli } from "../../support/cli/serveInProcessCli.js";
import { ownArtifactSession } from "../../support/mcp/artifactSession.js";
import { mcpTest } from "../../support/mcp/mcpFixture.js";

/**
 * One call, two adapters: every analysis operation the CLI exposes runs once
 * through the CLI command tree and once through the MCP server, over the same
 * provider and target. Both must deliver the same Evidence, or the
 * same failure.
 *
 * KNOWN_DIFFERENCES records the exact Evidence and failure fields where the
 * adapters still differ. Both adapters must retain the caller’s exact spelling.
 *
 * Simulated providers use authored results where the JSON Schema cannot
 * express the complete runtime contract. Archive cases use the production
 * artifact reader over a small ZIP fixture.
 */

/** JSON paths, under `evidence.` or `failure.`, where CLI and MCP differ. */
const KNOWN_DIFFERENCES: Readonly<Record<string, readonly string[]>> = {
  // `runProviderAnalysis` adds the target as `input_path` to the CLI
  // Evidence parameters, so the CLI Evidence has another identity.
  ...Object.fromEntries(
    [
      "inspect_macho",
      "inspect_signature",
      "inspect_plist",
      "list_architectures",
      "demangle_swift",
      "decode_interface_builder",
      "inspect_keyed_archive",
      "inspect_asset_catalog",
      "trace_dylib_resolution",
      "observe_native_ui",
      "capture_native_ui_scenario",
      "extract_artifact",
    ].map((name) => [
      name,
      ["evidence.evidence_id", "evidence.parameters.input_path"],
    ]),
  ),
  ...Object.fromEntries(
    [
      "inspect_managed_artifact",
      "inspect_managed_members",
      "inspect_managed_native_boundaries",
    ].map((name) => [
      name,
      [
        "evidence.evidence_id",
        "evidence.parameters.input_path",
        "evidence.parameters.path",
      ],
    ]),
  ),
  // The MCP inspection records the delivery detail and its selected path in
  // Evidence parameters; the CLI records the path as `input_path`.
  inspect_artifact: [
    "evidence.evidence_id",
    "evidence.parameters.detail",
    "evidence.parameters.input_path",
    "evidence.parameters.path",
  ],
  // `DirectAnalysis` shapes CLI failures in the application layer and adds
  // an `error: "Analysis failed"` marker MCP does not send.
  trace_native_ui_action: ["failure.error"],
};

/** Inputs a one-shot CLI call needs that MCP takes from session state. */
const INPUT_OVERRIDES: Readonly<
  Record<string, Readonly<Record<string, JsonValue>>>
> = {
  // MCP may fall back to the current address; a one-shot CLI has none.
  xrefs: { address: "0x1000" },
};

const PROVIDER = { id: "fixture", name: "Fixture", version: "1" } as const;

/** Valid replies for contracts with relationships absent from JSON Schema. */
const nativeUiResult = {
  target_sha256: "a".repeat(64),
  initial: {
    window: {
      pid: 123,
      window_id: 456,
      executable: "/fixture",
      launch_time: 0,
      title: "Fixture",
    },
    nodes: [],
    truncated: false,
    screenshot: null,
    gaps: [],
  },
  steps: [],
  restore: "leave-as-is",
  limitations: [],
} satisfies JsonValue;

const authoredResults = new Map<string, JsonValue>([
  [
    "read_bytes",
    {
      address: "0x1000",
      requested_bytes: 16,
      returned_bytes: 1,
      bytes_hex: "ab",
      complete: false,
    },
  ],
  ["observe_native_ui", nativeUiResult],
  [
    "capture_native_ui_scenario",
    {
      ...nativeUiResult,
      steps: [
        {
          index: 0,
          kind: "wait",
          before: nativeUiResult.initial,
          after: nativeUiResult.initial,
          outcome: "completed",
          reason: null,
        },
      ],
    },
  ],
]);

const results = new Map<string, JsonValue | undefined>();
const resultFor = (operation: string): JsonValue | undefined => {
  const authored = authoredResults.get(operation);
  if (authored !== undefined) return authored;
  if (!results.has(operation)) {
    const contract = TOOL_CONTRACTS.find(({ name }) => name === operation);
    results.set(
      operation,
      contract === undefined ? undefined : minimalContractResult(contract),
    );
  }
  return results.get(operation);
};

const session = () =>
  new BinarySession(
    createTestProviderRouter(() => ({
      execute: async (operation, parameters) =>
        ok(
          createAnalysisExecution(
            resultFor(operation) ?? { operation, parameters },
            PROVIDER,
          ),
        ),
      close: async () => ok(null),
    })),
  );

const dependencies: DirectAnalysisDependencies = {
  readConfiguration: () => parseConfig({}),
  createBinarySession: session,
  createNativeDispatchBinarySession: session,
  createArtifactBinarySession: session,
  createNativeBinarySession: session,
  createManagedBinarySession: session,
};

/** Loaded command modules; each case registers them on its own CLI. */
const registrations = await Promise.all(
  CLI_REGISTRATION_ORDER.map(async (id) => ({
    registration: CLI_COMMAND_REGISTRATIONS[id],
    module: await CLI_COMMAND_REGISTRATIONS[id].load(),
  })),
);

/** A fresh CLI command tree over the simulated provider. */
const createCli = (runWith = dependencies) =>
  createCliShell({
    selectedEnvironment: { REA_LOG_LEVEL: "silent" },
    createAnalysis: () => bindDirectAnalysis(runWith),
    registrations,
  });

/** The first CLI command that runs each contract (descriptions only). */
const { commands: descriptions } = registeredContractDescriptions(createCli());
const commands = new Map<string, ContractCliDescription>();
for (const description of descriptions)
  if (!commands.has(description.contract.name))
    commands.set(description.contract.name, description);

const OPERATIONS = [
  ...OFFICIAL_TOOL_CONTRACTS,
  ...ENHANCED_TOOL_CONTRACTS,
  ...NATIVE_TOOL_CONTRACTS,
  ...ARTIFACT_TOOL_CONTRACTS,
  ...MANAGED_TOOL_CONTRACTS,
].flatMap((contract) => {
  const description = commands.get(contract.name);
  return description === undefined ? [] : [{ contract, description }];
});

const kebab = (key: string): string =>
  key.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`);

const argvText = (value: JsonValue): string =>
  typeof value === "string" ? value : JSON.stringify(value);

/** The argv that spells one contract input for one CLI command. */
const argvFor = (
  description: ContractCliDescription,
  target: string,
  input: Readonly<Record<string, JsonValue>>,
): string[] => {
  const positionals: string[] = [];
  const options: string[] = [];
  for (const parameter of description.parameters) {
    const value = input[parameter.field];
    if (value === undefined) continue;
    if (parameter.positional || parameter.selectorOption !== undefined)
      positionals.push(
        ...(Array.isArray(value) ? value.map(argvText) : [argvText(value)]),
      );
    else if (parameter.jsonText || parameter.runtimeJson !== undefined)
      options.push(`--${kebab(parameter.key)}=${JSON.stringify(value)}`);
    else if (value === null && parameter.nullFlag !== undefined)
      options.push(`--${parameter.nullFlag}`);
    else if (parameter.booleanFlag)
      options.push(
        value === true
          ? `--${kebab(parameter.key)}`
          : `--${kebab(parameter.key)}=false`,
      );
    else if (parameter.repeatable && Array.isArray(value))
      for (const item of value)
        options.push(`--${kebab(parameter.key)}=${argvText(item)}`);
    else options.push(`--${kebab(parameter.key)}=${argvText(value)}`);
  }
  return [
    description.command,
    ...(description.sessionTarget === undefined ? [] : [target]),
    ...positionals,
    ...options,
    "--json",
  ];
};

/** Point an example's absolute paths into this case's own directory. */
const withFixturePaths = (value: JsonValue, directory: string): JsonValue => {
  if (typeof value === "string")
    return value.startsWith("/tmp/")
      ? join(directory, value.slice("/tmp/".length))
      : value;
  if (Array.isArray(value))
    return value.map((item) => withFixturePaths(item, directory));
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      withFixturePaths(item, directory),
    ]),
  );
};

/** One call's input, with complete detail so both adapters return Evidence. */
const callInput = (
  contract: (typeof OPERATIONS)[number]["contract"],
  description: ContractCliDescription,
  directory: string,
  target: string,
): Readonly<Record<string, JsonValue>> => {
  const input = withFixturePaths(
    contract.examples[0]?.input ?? minimalContractInput(contract) ?? {},
    directory,
  ) as Record<string, JsonValue>;
  return {
    ...input,
    ...("detail" in input ? { detail: "complete" } : {}),
    // The CLI target positional supplies a `path` field the contract owns.
    ...(description.sessionTarget !== undefined && "path" in description.fields
      ? { path: target }
      : {}),
    ...INPUT_OVERRIDES[contract.name],
  };
};

type Outcome =
  | { readonly outcome: "evidence"; readonly evidence: JsonValue }
  | { readonly outcome: "failure"; readonly failure: JsonValue };

const parseJson = (text: string): JsonValue => {
  try {
    return JSON.parse(text) as JsonValue;
  } catch {
    return text;
  }
};

const isObject = (
  value: unknown,
): value is Readonly<Record<string, JsonValue>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const evidenceOutcome = (value: unknown, target: string): Outcome => {
  if (!isObject(value)) throw new Error("Expected an Evidence response object");
  expect(value.caller_input_path).toBe(target);
  expect(value.caller_input_paths).toBeUndefined();
  return { outcome: "evidence", evidence: value };
};

const cliOutcome = (
  served: { readonly stdout: string; readonly exitCode: number },
  target: string,
): Outcome => {
  const value = parseJson(served.stdout);
  return served.exitCode !== 0
    ? { outcome: "failure", failure: value }
    : evidenceOutcome(value, target);
};

const mcpOutcome = (
  called: {
    readonly isError?: unknown;
    readonly structuredContent?: unknown;
    readonly content?: unknown;
  },
  target: string,
): Outcome => {
  if (called.isError !== true)
    return evidenceOutcome(called.structuredContent, target);
  const [first] = Array.isArray(called.content) ? called.content : [];
  const text =
    isObject(first) && typeof first.text === "string" ? first.text : "";
  const value = parseJson(text);
  return {
    outcome: "failure",
    failure: isObject(value) && "error" in value ? value.error : value,
  };
};

/** Leaf JSON paths where two values differ. */
const differences = (
  left: JsonValue | undefined,
  right: JsonValue | undefined,
  prefix = "",
): string[] => {
  if (JSON.stringify(left) === JSON.stringify(right)) return [];
  if (!isObject(left) || !isObject(right)) return [prefix];
  return [...new Set([...Object.keys(left), ...Object.keys(right)])]
    .sort()
    .flatMap((key) =>
      differences(
        left[key],
        right[key],
        prefix === "" ? key : `${prefix}.${key}`,
      ),
    );
};

it("covers every recorded difference with an operation the CLI runs", () => {
  const names = new Set(OPERATIONS.map(({ contract }) => contract.name));
  for (const name of [
    ...Object.keys(KNOWN_DIFFERENCES),
    ...Object.keys(INPUT_OVERRIDES),
  ])
    expect(names, name).toContain(name);
});

mcpTest.for(
  OPERATIONS.map((operation) => [operation.contract.name, operation] as const),
)(
  "%s returns the same Evidence through the CLI and MCP",
  async ([name, { contract, description }], { mcp, onTestFinished }) => {
    const directory = await createTestTempDirectory("rea-adapter-parity-");
    const realArtifact =
      name === "inspect_artifact" || name === "extract_artifact";
    if (realArtifact)
      await writeOrderedZip(join(directory, "fixture"), ["member.txt"]);
    else await writeFile(join(directory, "fixture"), minimalMachoImage(64));
    // Both adapters select the same file through the same noncanonical spelling.
    const target = `${directory}/./fixture`;
    const input = {
      ...callInput(contract, description, directory, target),
      ...(name === "extract_artifact"
        ? { output_root: join(directory, "extracted") }
        : {}),
    };
    const cli = createCli(
      realArtifact
        ? {
            ...dependencies,
            createArtifactBinarySession: () => createArtifactBinarySession({}),
          }
        : dependencies,
    );
    const cliResult = cliOutcome(
      await serveInProcessCli(cli, argvFor(description, target, input)),
      target,
    );
    // Each adapter writes caller-selected outputs into a fresh location.
    for (const value of Object.values(input))
      if (
        typeof value === "string" &&
        value !== target &&
        value.startsWith(`${directory}/`)
      )
        await rm(value, { recursive: true, force: true });
    const mcpSession = realArtifact
      ? await createArtifactBinarySession({})
      : session();
    if (realArtifact) ownArtifactSession(mcpSession, onTestFinished);
    const client = await mcp.connect(
      createServer(
        { kind: "session", session: mcpSession },
        { environment: { ...process.env, ...INLINE_EVIDENCE_MCP_ENVIRONMENT } },
      ),
    );
    const opened = await client.callTool({
      name: "open_binary",
      arguments: { path: target },
    });
    expect(opened.isError, JSON.stringify(opened.content)).not.toBe(true);
    const mcpResult = mcpOutcome(
      await client.callTool({ name, arguments: input }),
      target,
    );
    if (realArtifact || authoredResults.has(name)) {
      expect(cliResult.outcome, JSON.stringify(cliResult)).toBe("evidence");
      expect(mcpResult.outcome, JSON.stringify(mcpResult)).toBe("evidence");
    }
    const found = differences(
      cliResult as unknown as JsonValue,
      mcpResult as unknown as JsonValue,
    );
    expect(found).toEqual(KNOWN_DIFFERENCES[name] ?? []);
  },
);
