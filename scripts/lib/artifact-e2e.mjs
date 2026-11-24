import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { createVerifierCommands } from "./verify-commands.mjs";
import { createOwnedMcpStdioTransport } from "./owned-mcp-stdio.mjs";
import { withVerifierCleanup } from "./verifier-cleanup.mjs";
import { INLINE_EVIDENCE_MCP_ENVIRONMENT } from "./mcp-verification-environment.mjs";
import { withCanonicalOutputSchema } from "./canonical-output-schema.mjs";

// Bind parsed definitions to this connection. Hot/cold catalogs may add tools;
// refresh a missing name once without throwing away already validated bindings.
const toolBindings = new WeakMap();
const readDefinitions = (client) =>
  client.listTools().then(({ tools }) => {
    const definitions = new Map();
    for (const tool of tools) {
      assert.ok(
        !definitions.has(tool.name),
        `Duplicate MCP tool: ${tool.name}`,
      );
      definitions.set(tool.name, tool);
    }
    return definitions;
  });

const advertisedTool = async (client, name) => {
  const connection = client.getServerVersion();
  assert.ok(connection, "MCP must be initialized before binding tool schemas");
  let binding = toolBindings.get(client);
  if (binding?.connection !== connection) {
    binding = {
      connection,
      definitions: readDefinitions(client),
    };
    toolBindings.set(client, binding);
  }
  let definitions;
  const snapshot = binding.definitions;
  try {
    definitions = await snapshot;
    if (!definitions.has(name)) {
      if (binding.definitions === snapshot)
        binding.definitions = readDefinitions(client);
      definitions = await binding.definitions;
    }
    assert.equal(
      client.getServerVersion(),
      connection,
      "MCP connection changed while binding tool schemas",
    );
  } catch (cause) {
    if (toolBindings.get(client) === binding) toolBindings.delete(client);
    throw cause;
  }
  const tool = definitions.get(name);
  assert.ok(tool, `MCP catalog did not advertise ${name}`);
  return tool;
};

/** Call an advertised tool with SDK output validation against its canonical contract. */
export async function artifactMcpCall(client, parameters, options = {}) {
  options.signal?.throwIfAborted();
  assert.equal(
    options.toolDefinition,
    undefined,
    "Artifact verification owns the advertised schema; pass request options only",
  );
  // tools/list omits output schemas by default; bind the canonical contract.
  const toolDefinition = withCanonicalOutputSchema(
    await advertisedTool(client, parameters.name),
  );
  options.signal?.throwIfAborted();
  return client.callTool(parameters, { ...options, toolDefinition });
}

/** Retain the exact command owner when a verifier cannot finish cleanup. */
class ArtifactVerifierCleanupError extends Error {
  constructor(cause, cleanupOwner) {
    super("Artifact verifier cleanup is incomplete", { cause });
    this.name = "ArtifactVerifierCleanupError";
    this.cleanupOwner = cleanupOwner;
  }
}

const closeOwnedCommands = async (owner) => {
  try {
    await owner.close();
  } catch (cause) {
    throw new ArtifactVerifierCleanupError(cause, owner);
  }
};

const environment = () => {
  const compileCache =
    process.env.NODE_COMPILE_CACHE ??
    process.env.REA_ARTIFACT_NODE_COMPILE_CACHE;
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    ...(compileCache &&
    process.env.NODE_V8_COVERAGE === undefined &&
    process.env.NODE_DISABLE_COMPILE_CACHE !== "1"
      ? { NODE_COMPILE_CACHE: compileCache }
      : {}),
    REA_LOG_LEVEL: "silent",
    REA_ANALYSIS_PROVIDER: "auto",
    // Artifact workflows have no deep-provider prerequisite or GUI authority.
    HOPPER_LAUNCHER_PATH: "/rea-unconfigured-deep-provider/hopper",
  };
};

/** Execute the compiled CLI with production providers and no test adapters. */
export async function artifactCli(
  command,
  target,
  arguments_ = [],
  options = {},
) {
  return (await artifactCliEvidence(command, target, arguments_, options))
    .normalized_result;
}

const executeArtifactCli = (
  owner,
  command,
  target,
  arguments_,
  { timeoutMs, signal },
) =>
  owner.exec(
    process.execPath,
    [
      fileURLToPath(new URL("../rea.mjs", import.meta.url)),
      command,
      target,
      ...arguments_,
      "--json",
    ],
    {
      env: environment(),
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
      signal,
    },
  );

/** Execute the compiled CLI and return its complete Evidence record. */
export async function artifactCliEvidence(
  command,
  target,
  arguments_ = [],
  { timeoutMs = 60000, signal, commands } = {},
) {
  signal?.throwIfAborted();
  const owner = commands ?? (await createVerifierCommands());
  const execute = () =>
    executeArtifactCli(owner, command, target, arguments_, {
      timeoutMs,
      signal,
    });
  const { stdout } =
    commands === undefined
      ? await withVerifierCleanup(execute, [() => closeOwnedCommands(owner)])
      : await execute();
  signal?.throwIfAborted();
  const evidence = JSON.parse(stdout);
  assert.equal(evidence.error, undefined, stdout);
  assert.ok(evidence.normalized_result, "CLI omitted normalized result");
  return evidence;
}

/**
 * Execute the compiled CLI in the same environment as `artifactCliEvidence`
 * for a run that must fail, and return its JSON error record. A run that
 * succeeds, or exits without a complete error record, is a failure.
 */
export async function artifactCliFailure(
  command,
  target,
  arguments_ = [],
  { timeoutMs = 60000, signal } = {},
) {
  signal?.throwIfAborted();
  const owner = await createVerifierCommands();
  const exited = await withVerifierCleanup(async () => {
    try {
      const { stdout } = await executeArtifactCli(
        owner,
        command,
        target,
        arguments_,
        { timeoutMs, signal },
      );
      throw new Error(`${command} unexpectedly succeeded: ${stdout}`);
    } catch (cause) {
      if (cause?.name !== "VerifierCommandExitError") throw cause;
      return cause;
    }
  }, [() => closeOwnedCommands(owner)]);
  const { stdout } = exited.snapshot;
  assert.ok(
    stdout.bytes === stdout.observedBytes && stdout.invalidUtf8 !== true,
    `${command} stdout was not retained completely`,
  );
  const record = JSON.parse(stdout.text);
  assert.equal(typeof record.code, "string", stdout.text);
  return record;
}

const withOpenedArtifactMcp = async (
  target,
  openTool,
  verify,
  options = {},
) => {
  options.signal?.throwIfAborted();
  const owner = options.commands ?? (await createVerifierCommands());
  const transport = await createOwnedMcpStdioTransport({
    command: process.execPath,
    arguments: [fileURLToPath(new URL("../rea.mjs", import.meta.url)), "mcp"],
    hostEnvironment: { ...environment(), ...INLINE_EVIDENCE_MCP_ENVIRONMENT },
    cwd: process.cwd(),
    expectedCommand: null,
    sweepTokenOwnedProcesses: true,
    signal: options.signal,
  });
  owner.adopt(transport, "artifact MCP process");
  const client = new Client({ name: "artifact-real-e2e", version: "1" });
  let clientClose;
  const closeClient = () =>
    (clientClose ??= Promise.resolve().then(() => client.close()));
  const abortTransport = () => {
    // Keep the same promise for finalization; concurrent SDK closes can return
    // before the first close has observed the child exit.
    void closeClient().catch(() => undefined);
  };
  options.signal?.addEventListener("abort", abortTransport, { once: true });
  try {
    const result = await withVerifierCleanup(async () => {
      options.signal?.throwIfAborted();
      await client.connect(transport);
      options.signal?.throwIfAborted();
      const opened = await artifactMcpCall(
        client,
        {
          name: openTool,
          arguments: { path: target },
        },
        { signal: options.signal },
      );
      assert.notEqual(opened.isError, true, JSON.stringify(opened));
      if (openTool === "open_bundle_resources")
        assert.equal(opened.structuredContent?.result?.caller_path, target);
      await verify(client);
    }, [
      () => {
        toolBindings.delete(client);
      },
      () => closeClient(),
      () => transport.close(),
      ...(options.commands === undefined
        ? [() => closeOwnedCommands(owner)]
        : []),
    ]);
    options.signal?.throwIfAborted();
    return result;
  } finally {
    options.signal?.removeEventListener("abort", abortTransport);
  }
};

/** Run a real stdio MCP subprocess with an explicitly opened binary target. */
export async function withArtifactMcp(target, verify, options = {}) {
  return withOpenedArtifactMcp(target, "open_binary", verify, options);
}

/** Run a real stdio MCP subprocess with an explicitly opened bundle resource root. */
export async function withBundleResourcesMcp(target, verify, options = {}) {
  return withOpenedArtifactMcp(
    target,
    "open_bundle_resources",
    verify,
    options,
  );
}

/** Require a successful structured MCP tool result rather than its text rendering. */
export async function artifactMcpResult(
  client,
  name,
  arguments_ = {},
  options = {},
) {
  const result = await artifactMcpCall(
    client,
    {
      name,
      arguments: arguments_,
    },
    options,
  );
  assert.notEqual(result.isError, true, JSON.stringify(result));
  assert.ok(
    result.structuredContent?.normalized_result,
    "MCP omitted structured result",
  );
  return result.structuredContent.normalized_result;
}
