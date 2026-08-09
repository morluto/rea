import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { format } from "prettier";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";

import { TOOL_CONTRACTS } from "../dist/contracts/toolContracts.js";
import { MANAGED_WORKFLOW_TOOL_CONTRACTS } from "../dist/contracts/managedWorkflowToolContracts.js";
import { ArtifactProvider } from "../dist/artifacts/ArtifactProvider.js";
import { ManagedStaticProvider } from "../dist/dotnet/ManagedStaticProvider.js";
import { NativeMacOSProvider } from "../dist/native/NativeMacOSProvider.js";
import { toolRegistrationOptions } from "../dist/server/toolRegistrationOptions.js";
import { ensureGeneratedFile } from "./lib/generated-file.mjs";

const arguments_ = new Set(process.argv.slice(2));
for (const argument of arguments_)
  if (argument !== "--check")
    throw new Error(`Unknown MCP tool catalog option: ${argument}`);

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// The checked-in catalog is a portable package artifact. Keep its canonical
// provider metadata independent of the machine running the generator.
const CATALOG_PLATFORM = "darwin";
const sessionToolNames = new Set([
  ...TOOL_CONTRACTS.filter(({ kind }) => kind === "session").map(
    ({ name }) => name,
  ),
  ...MANAGED_WORKFLOW_TOOL_CONTRACTS.map(({ name }) => name),
]);
const advertisedTools = await sdkToolCatalog();
const catalog = TOOL_CONTRACTS.map((contract) => {
  const advertised = advertisedTools.get(contract.name);
  if (advertised === undefined)
    throw new Error(`MCP SDK omitted registered tool ${contract.name}`);
  return {
    name: contract.name,
    analysisOperation: [
      "official-proxy",
      "enhanced",
      "native-provider",
      "artifact-provider",
      "managed-provider",
    ].includes(contract.kind)
      ? contract.name
      : null,
    title: advertised.title,
    description: advertised.description,
    kind: contract.kind,
    requiresSession: sessionToolNames.has(contract.name),
    inputSchema: advertised.inputSchema,
    outputSchema: advertised.outputSchema,
    annotations: advertised.annotations,
    effects: contract.effects,
  };
});

async function sdkToolCatalog() {
  const server = new McpServer({ name: "rea-catalog-generator", version: "0" });
  for (const contract of TOOL_CONTRACTS)
    server.registerTool(
      contract.name,
      toolRegistrationOptions(contract),
      async () => ({
        content: [{ type: "text", text: "Catalog-only handler" }],
        isError: true,
      }),
    );
  const client = new Client({ name: "rea-catalog-generator", version: "0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const { tools } = await client.listTools();
    return new Map(tools.map((tool) => [tool.name, tool]));
  } finally {
    await Promise.allSettled([client.close(), server.close()]);
  }
}
const auxiliaryProviders = [
  new ArtifactProvider(false, false),
  new NativeMacOSProvider(undefined, CATALOG_PLATFORM),
  new ManagedStaticProvider(),
].map((provider) => ({
  identity: provider.identity(),
  capabilities: provider.capabilities(),
}));

const canonicalizeJson = (value) => {
  if (Array.isArray(value)) return value.map(canonicalizeJson);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => [key, canonicalizeJson(entry)]),
  );
};

const payloadJson = JSON.stringify(
  canonicalizeJson({ catalog, auxiliaryProviders }),
);
const source = await format(
  `import type { ToolAnnotations } from "@modelcontextprotocol/server";
import type {
  CapabilityDescriptor,
  ProviderIdentity,
} from "./application/AnalysisProvider.js";
import type { ToolKind } from "./contracts/toolContractTypes.js";
import type { ToolEffects } from "./contracts/toolEffects.js";

interface GeneratedTool {
  readonly name: string;
  readonly analysisOperation: CapabilityDescriptor["operation"] | null;
  readonly title: string;
  readonly description: string;
  readonly kind: ToolKind;
  readonly requiresSession: boolean;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly outputSchema: Readonly<Record<string, unknown>>;
  readonly annotations: ToolAnnotations;
  readonly effects: ToolEffects;
}

interface GeneratedProvider {
  readonly identity: ProviderIdentity;
  readonly capabilities: readonly CapabilityDescriptor[];
}

interface GeneratedPayload {
  readonly catalog: readonly GeneratedTool[];
  readonly auxiliaryProviders: readonly GeneratedProvider[];
}

const GENERATED_PAYLOAD_JSON = ${JSON.stringify(payloadJson)};
const generatedPayload: unknown = JSON.parse(GENERATED_PAYLOAD_JSON);
if (!isGeneratedPayload(generatedPayload))
  throw new TypeError("Generated MCP catalog payload is invalid");

/** Generated from TOOL_CONTRACTS; do not edit. */
export const GENERATED_MCP_TOOL_CATALOG = generatedPayload.catalog;

/** Generated lightweight metadata for lazily loaded auxiliary providers. */
export const GENERATED_AUXILIARY_PROVIDERS = generatedPayload.auxiliaryProviders;

function isGeneratedPayload(value: unknown): value is GeneratedPayload {
  return (
    isRecord(value) &&
    Array.isArray(value.catalog) &&
    value.catalog.every(isGeneratedTool) &&
    Array.isArray(value.auxiliaryProviders) &&
    value.auxiliaryProviders.every(isGeneratedProvider)
  );
}

function isGeneratedTool(value: unknown): value is GeneratedTool {
  return (
    isRecord(value) &&
    typeof value.name === "string" &&
    (typeof value.analysisOperation === "string" ||
      value.analysisOperation === null) &&
    typeof value.title === "string" &&
    typeof value.description === "string" &&
    typeof value.kind === "string" &&
    typeof value.requiresSession === "boolean" &&
    isRecord(value.inputSchema) &&
    isRecord(value.outputSchema) &&
    isRecord(value.annotations) &&
    isRecord(value.effects)
  );
}

function isGeneratedProvider(value: unknown): value is GeneratedProvider {
  return (
    isRecord(value) &&
    isRecord(value.identity) &&
    Array.isArray(value.capabilities)
  );
}

function isRecord(
  value: unknown,
): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
`,
  { parser: "typescript" },
);

await ensureGeneratedFile({
  path: join(root, "src/generatedMcpToolCatalog.ts"),
  source,
  check: arguments_.has("--check"),
  generateCommand: "npm run mcp-catalog:generate",
});
