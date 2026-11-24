import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";

// Runtime discovery is generated from the same canonical registrations, after
// default identity has been recorded and before bundling.
const compiled = resolve(dirname(fileURLToPath(import.meta.url)), "../dist");
const read = (name) => import(pathToFileURL(join(compiled, name)).href);
const [
  { createServer },
  { createBinarySession },
  { parseConfig },
  { silentLogger },
  { PROMPT_CONTRACTS },
  { TOOL_CONTRACTS },
  { getEvidenceInputContract },
  { toolOutputSchemaWithMetadata },
  { toolFamilyId },
  { requiredPromptTools },
] = await Promise.all([
  read("server/createServer.js"),
  read("composition/binary.js"),
  read("config/parseConfig.js"),
  read("logger.js"),
  read("contracts/promptContracts.js"),
  read("contracts/toolContracts.js"),
  read("domain/evidenceInputContract.js"),
  read("contracts/toolSchemaMetadata.js"),
  read("contracts/toolFamilies.js"),
  read("contracts/promptToolFamilyScope.js"),
]);
const recordCatalog = async () => {
  // Catalog generation is independent of the host account and user configuration.
  const home = await mkdtemp(join(tmpdir(), "rea-mcp-catalog-"));
  const environment = {
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, "config"),
    XDG_CACHE_HOME: join(home, "cache"),
    XDG_STATE_HOME: join(home, "state"),
  };
  const cleanup = [];
  let producerFailure;
  try {
    const config = parseConfig(environment);
    if (!config.ok) throw config.error;
    const session = createBinarySession(
      config.value,
      silentLogger,
      environment,
    );
    cleanup.push(async () => {
      const closed = await session.close({ retainProviderDocuments: true });
      if (!closed.ok) throw closed.error;
    });
    const server = createServer({ kind: "session", session }, { environment });
    cleanup.push(() => server.close());
    const client = new Client({ name: "rea-catalog-recorder", version: "1" });
    cleanup.push(() => client.close());
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const tools = (await client.listTools()).tools.map((tool) => {
      const contract = TOOL_CONTRACTS.find(({ name }) => name === tool.name);
      if (contract === undefined) throw new Error(`Missing tool ${tool.name}`);
      const outputSchema = toolOutputSchemaWithMetadata(contract)[
        "~standard"
      ].jsonSchema.output({ target: "draft-2020-12" });
      return {
        ...tool,
        // Deferred listings omit outputs and calls use canonical validation.
        // An object root is enough for the SDK's legacy result codec. Keep
        // other roots intact for wrapping, and the session schema for doctor.
        outputSchema:
          tool.name === "binary_session" || outputSchema.type !== "object"
            ? outputSchema
            : { type: "object" },
      };
    });
    // Record the compact schemas a legacy client receives. The SDK stamps or
    // wraps a non-object root before REA compacts that listing.
    const compactServer = createServer(
      { kind: "session", session },
      {
        environment: {
          ...environment,
          REA_MCP_OUTPUT_SCHEMA_PROFILE: "compact",
        },
      },
    );
    cleanup.push(() => compactServer.close());
    const compactClient = new Client({
      name: "rea-catalog-recorder-compact",
      version: "1",
    });
    cleanup.push(() => compactClient.close());
    const [compactClientTransport, compactServerTransport] =
      InMemoryTransport.createLinkedPair();
    await compactServer.connect(compactServerTransport);
    await compactClient.connect(compactClientTransport);
    const compactOutputSchemas = Object.fromEntries(
      (await compactClient.listTools()).tools.flatMap((tool) =>
        tool.outputSchema === undefined ? [] : [[tool.name, tool.outputSchema]],
      ),
    );
    const prompts = (await client.listPrompts()).prompts.map((prompt) => {
      const contract = PROMPT_CONTRACTS.find(
        (candidate) => candidate.name === prompt.name,
      );
      if (contract === undefined)
        throw new Error(`Missing prompt ${prompt.name}`);
      return { ...prompt, parameters: contract.arguments };
    });
    const catalog = {
      version: 1,
      info: client.getServerVersion(),
      capabilities: client.getServerCapabilities(),
      instructions: client.getInstructions(),
      identity: server.catalogIdentity,
      tools,
      compactOutputSchemas,
      toolFamilies: Object.fromEntries(
        tools.map(({ name }) => {
          const family = toolFamilyId(name);
          if (family === undefined)
            throw new Error(`Missing family for ${name}`);
          return [name, family];
        }),
      ),
      promptRequirements: Object.fromEntries(
        PROMPT_CONTRACTS.map((contract) => [
          contract.name,
          requiredPromptTools(contract),
        ]),
      ),
      evidenceReferenceAlternatives: TOOL_CONTRACTS.filter(
        (contract) =>
          getEvidenceInputContract(contract.inputSchema)
            .hasEvidenceReferenceAlternative,
      ).map((contract) => contract.name),
      prompts,
    };
    const encoded = JSON.stringify(catalog);
    const digest = createHash("sha256").update(encoded).digest("hex");
    await writeFile(join(compiled, "mcp-catalog.json"), encoded);
    return digest;
  } catch (cause) {
    producerFailure = { cause };
    throw cause;
  } finally {
    const results = await Promise.allSettled(
      cleanup.reverse().map((close) => Promise.resolve().then(close)),
    );
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (failures.length === 0) {
      try {
        await rm(home, { recursive: true, force: true });
      } catch (cause) {
        failures.push(cause);
      }
    }
    if (failures.length > 0)
      throw new AggregateError(
        producerFailure === undefined
          ? failures
          : [producerFailure.cause, ...failures],
        `Catalog cleanup failed; temporary home retained at ${home}`,
      );
  }
};

const digest = await recordCatalog();
await writeFile(
  join(compiled, "recordedMcpCatalog.js"),
  `/** Recorded from the compiled runtime; do not edit. */\nexport const RECORDED_MCP_CATALOG_SHA256 = ${JSON.stringify(digest)};\n`,
);
