import { execFile } from "node:child_process";
import { readdir, realpath } from "node:fs/promises";
import { promisify } from "node:util";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

import { TOOL_CONTRACTS } from "../dist/contracts/toolContracts.js";

const execFileAsync = promisify(execFile);
const timeout = 180_000;
const hopperProcessPrefix = "/Applications/Hopper Disassembler.app/Contents/";
// Snapshot bundle processes so cleanup terminates only Hopper processes this
// verifier caused to appear, never an instance the user already had running.
const hopperProcessesBefore = await hopperProcessIds();
const sessionsBefore = new Set(
  (await readdir("/tmp")).filter((name) => name.startsWith("rea-")),
);

const textValue = (result) => {
  const text = result.content?.find((item) => item.type === "text")?.text;
  if (typeof text !== "string") throw new Error("Tool result omitted text");
  return text;
};

const jsonValue = (result) => JSON.parse(textValue(result));

const requireSuccessfulTool = (result, operation) => {
  if (result.isError === true) {
    throw new Error(`${operation} failed: ${textValue(result)}`);
  }
  const value = jsonValue(result);
  if (value === null || typeof value !== "object" || !("result" in value)) {
    throw new Error(`${operation} omitted its evidence result`);
  }
  return value.result;
};

const firstProcedureAddress = (result) => {
  const items = result.structuredContent?.result?.items;
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error("The verifier target contains no analyzed procedure");
  }
  const address = items[0]?.address;
  if (typeof address !== "string" || !/^0x[0-9a-f]+$/iu.test(address)) {
    throw new Error("list_procedures returned an invalid procedure address");
  }
  return address;
};

const requirePseudocode = (value, operation) => {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${operation} returned empty pseudocode`);
  }
  if (value === "No output" || value.startsWith("Error:")) {
    throw new Error(`${operation} returned an embedded failure: ${value}`);
  }
  return value;
};

const requireFunctionDossier = (value, expectedAddress) => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("analyze_function returned no function dossier");
  }
  if (value.procedure?.address !== expectedAddress) {
    throw new Error("analyze_function returned the wrong procedure");
  }
  if (
    typeof value.procedure?.name !== "string" ||
    value.procedure.name.trim().length === 0
  ) {
    throw new Error("analyze_function omitted the procedure name");
  }
  requirePseudocode(value.pseudocode?.text, "analyze_function");
  for (const field of [
    "comments",
    "callers",
    "callees",
    "incoming_references",
    "basic_blocks",
  ]) {
    const collection = value[field];
    if (
      collection === null ||
      typeof collection !== "object" ||
      !Array.isArray(collection.items) ||
      !Number.isInteger(collection.total)
    ) {
      throw new Error(`analyze_function returned an invalid ${field} result`);
    }
  }
  return value;
};

const requireSafeDiagnostics = (chunks) => {
  const lines = chunks
    .join("")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  for (const line of lines) {
    let diagnostic;
    try {
      diagnostic = JSON.parse(line);
    } catch {
      throw new Error(`The MCP runtime emitted malformed stderr: ${line}`);
    }
    if (
      diagnostic === null ||
      typeof diagnostic !== "object" ||
      diagnostic.application !== "rea" ||
      typeof diagnostic.level !== "number" ||
      diagnostic.level >= 40
    ) {
      throw new Error(`The MCP runtime emitted unsafe stderr: ${line}`);
    }
  }
  return lines.length;
};

const targetPath = process.env.HOPPER_TARGET_PATH;
const secondTargetPath = process.env.HOPPER_SECOND_TARGET_PATH;
if (!targetPath || !secondTargetPath)
  throw new Error(
    "HOPPER_TARGET_PATH and HOPPER_SECOND_TARGET_PATH are required and must name distinct binaries",
  );
const [targetA, targetB] = await Promise.all([
  realpath(targetPath),
  realpath(secondTargetPath),
]);
if (targetA === targetB)
  throw new Error("Real-Hopper verification requires two distinct targets");
const serverEnvironment = { ...process.env };
delete serverEnvironment.HOPPER_TARGET_PATH;
delete serverEnvironment.HOPPER_SECOND_TARGET_PATH;

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["dist/main.js"],
  cwd: process.cwd(),
  env: serverEnvironment,
  stderr: "pipe",
});
let stderrBytes = 0;
const stderrChunks = [];
transport.stderr?.on("data", (chunk) => {
  stderrBytes += chunk.length;
  if (stderrBytes <= 16_384) stderrChunks.push(chunk.toString("utf8"));
});
const client = new Client({ name: "real-hopper-verifier", version: "1.0.0" });
let summary;

try {
  await client.connect(transport);
  const listed = await client.listTools();
  const expectedNames = TOOL_CONTRACTS.map(({ name }) => name).sort();
  const actualNames = listed.tools.map(({ name }) => name).sort();
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
    throw new Error("The real server did not expose the intended 46 tools");
  }

  const options = { timeout };
  const initialSession = await client.callTool(
    { name: "binary_session", arguments: {} },
    options,
  );
  if (jsonValue(initialSession).open !== false)
    throw new Error("The verifier did not start without a target");
  const opened = await client.callTool(
    { name: "open_binary", arguments: { path: targetA } },
    options,
  );
  if (opened.isError === true) throw new Error(textValue(opened));
  const documents = await client.callTool(
    { name: "list_documents", arguments: {} },
    options,
  );
  const overview = await client.callTool(
    { name: "binary_overview", arguments: {} },
    options,
  );
  const segments = await client.callTool(
    { name: "list_segments", arguments: {} },
    options,
  );
  const procedures = await client.callTool(
    { name: "list_procedures", arguments: {} },
    options,
  );
  requireSuccessfulTool(procedures, "list_procedures");
  const firstAddress = firstProcedureAddress(procedures);
  const containment = requireSuccessfulTool(
    await client.callTool(
      {
        name: "resolve_containing_procedure",
        arguments: { address: firstAddress },
      },
      options,
    ),
    "resolve_containing_procedure",
  );
  if (
    containment?.found !== true ||
    containment.procedure?.address !== firstAddress
  ) {
    throw new Error(
      "resolve_containing_procedure returned the wrong procedure",
    );
  }
  const references = requireSuccessfulTool(
    await client.callTool(
      {
        name: "procedure_references",
        arguments: {
          procedure: firstAddress,
          direction: "outgoing",
          limit: 10,
          max_instructions: 100,
        },
      },
      options,
    ),
    "procedure_references",
  );
  if (!Array.isArray(references?.references?.items)) {
    throw new Error("procedure_references returned an invalid bounded result");
  }
  const bounded = await client.callTool(
    { name: "batch_decompile", arguments: { addresses: [firstAddress] } },
    options,
  );
  const boundedResult = requireSuccessfulTool(bounded, "batch_decompile");
  if (
    boundedResult === null ||
    typeof boundedResult !== "object" ||
    Array.isArray(boundedResult)
  ) {
    throw new Error("batch_decompile returned an invalid result");
  }
  const boundedPseudocode = requirePseudocode(
    boundedResult[firstAddress],
    "batch_decompile",
  );
  const dossier = requireFunctionDossier(
    requireSuccessfulTool(
      await client.callTool(
        {
          name: "analyze_function",
          arguments: { procedure: firstAddress },
        },
        options,
      ),
      "analyze_function",
    ),
    firstAddress,
  );
  const switched = await client.callTool(
    { name: "open_binary", arguments: { path: targetB } },
    options,
  );
  if (switched.isError === true) throw new Error(textValue(switched));
  const secondSession = jsonValue(
    await client.callTool({ name: "binary_session", arguments: {} }, options),
  );
  if (secondSession.path !== targetB)
    throw new Error("The real session did not switch to target B");
  const secondOverview = await client.callTool(
    { name: "binary_overview", arguments: {} },
    options,
  );
  if (secondOverview.isError === true)
    throw new Error(textValue(secondOverview));

  const processList = await execFileAsync("ps", ["-ax", "-o", "command="]);
  const bundledMcpRunning = processList.stdout
    .split("\n")
    .some((line) => line.trim().endsWith("/HopperMCPServer"));
  if (bundledMcpRunning) {
    throw new Error(
      "Hopper's bundled MCP server was running during verification",
    );
  }
  const diagnosticCount = requireSafeDiagnostics(stderrChunks);

  const closed = await client.callTool(
    { name: "close_binary", arguments: {} },
    options,
  );
  if (closed.isError === true) throw new Error(textValue(closed));

  summary = {
    toolCount: actualNames.length,
    documentCount: jsonValue(documents).length,
    overview: jsonValue(overview),
    segmentCount: jsonValue(segments).length,
    boundedTool: "batch_decompile",
    boundedInputCount: 1,
    boundedResultKeys: Object.keys(boundedResult).length,
    boundedPseudocodeChars: boundedPseudocode.length,
    analyzedProcedure: dossier.procedure,
    analyzedPseudocodeChars: dossier.pseudocode.text.length,
    bundledMcpRunning,
    stderrBytes,
    diagnosticCount,
    dynamicSession: true,
    targets: [targetA, targetB],
    switched: true,
    secondOverview: jsonValue(secondOverview),
  };
} finally {
  const keepAlive = setInterval(() => undefined, 100);
  try {
    await client.close();
    await transport.close();
  } finally {
    clearInterval(keepAlive);
    await terminateNewHopperProcesses(hopperProcessesBefore);
  }
}

await new Promise((resolve) => setTimeout(resolve, 500));
const sessionsAfter = (await readdir("/tmp")).filter(
  (name) => name.startsWith("rea-") && !sessionsBefore.has(name),
);
if (sessionsAfter.length > 0) {
  throw new Error("The MCP runtime leaked a bridge session directory");
}
const afterCloseProcesses = await execFileAsync("ps", [
  "-ax",
  "-o",
  "command=",
]);
if (
  afterCloseProcesses.stdout
    .split("\n")
    .some((line) => line.includes("node dist/main.js"))
) {
  throw new Error(
    "The TypeScript MCP server remained alive after client close",
  );
}
if (summary === undefined)
  throw new Error("Real-Hopper verification did not produce a summary");
await new Promise((resolve, reject) => {
  process.stdout.write(
    `${JSON.stringify({ ...summary, cleanShutdown: true }, null, 2)}\n`,
    (cause) => {
      if (cause) reject(cause);
      else resolve();
    },
  );
});

async function hopperProcessIds() {
  const result = await execFileAsync("ps", ["-ax", "-o", "pid=,command="]);
  return new Set(
    result.stdout
      .split("\n")
      .map((line) => line.trim().match(/^(\d+)\s+(.+)$/))
      .filter((match) => match?.[2]?.startsWith(hopperProcessPrefix) === true)
      .map((match) => Number(match[1])),
  );
}

async function terminateNewHopperProcesses(previous) {
  const current = await hopperProcessIds();
  const owned = [...current].filter((pid) => !previous.has(pid));
  for (const pid of owned) signalProcess(pid, "SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  for (const pid of owned)
    if (signalProcess(pid, 0)) signalProcess(pid, "SIGKILL");
}

function signalProcess(pid, signal) {
  try {
    process.kill(pid, signal);
    return true;
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ESRCH")
      return false;
    throw cause;
  }
}
