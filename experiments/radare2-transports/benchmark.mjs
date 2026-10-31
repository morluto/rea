// Explicit local experiment. No provider registration or package changes.
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const [configuration, lane, targetId, output] = process.argv.slice(2);
const config = JSON.parse(await readFile(configuration, "utf8"));
const target = config.targets.find((target) => target.id === targetId);
if (!target || !config.lanes.includes(lane))
  throw new Error("Unknown benchmark selection");
await mkdir(output, { recursive: true });
const digest = async () =>
  createHash("sha256")
    .update(await readFile(target.path))
    .digest("hex");
const before = await digest();
const upstream = lane.startsWith("r2mcp");
const transport = new StdioClientTransport({
  command: upstream ? config.r2mcp : process.execPath,
  args: upstream
    ? [
        "-N",
        "-d",
        "pdg",
        "-c",
        "e asm.dwarf=false;e scr.utf8=0",
        ...(lane === "r2mcp-raw" ? ["-r"] : []),
      ]
    : [resolve(config.rea3521, "scripts/rea.mjs"), "mcp"],
  env: {
    ...process.env,
    REA_LOG_LEVEL: "silent",
    R2_COLOR: "0",
    R2_UTF8: "0",
    REA_R2_COMMAND: config.r2,
    REA_ANALYSIS_PROVIDER: "ghidra",
    GHIDRA_INSTALL_DIR: config.ghidra,
    JAVA_HOME: config.java,
  },
  stderr: "pipe",
});
const diagnostics = [];
transport.stderr?.on("data", (bytes) => diagnostics.push(bytes));
const client = new Client({ name: "rea-r2-ghidra-benchmark", version: "1" });
const calls = [];
let catalog;
let session;
let opened = false;
let failure;
let firstTaskMs;
let firstReplyBytes;
let firstTexts;
const warm = [];
const began = performance.now();
const plain = (reply) => {
  if (reply.structuredContent !== undefined) return reply.structuredContent;
  const text =
    reply.content
      ?.filter((item) => item.type === "text")
      .map((item) => item.text)
      .join("\n") ?? "";
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};
async function call(name, args) {
  if (!catalog.tools.some((tool) => tool.name === name))
    throw new Error(`Missing advertised tool: ${name}`);
  const started = performance.now();
  const reply = await client.callTool(
    { name, arguments: args },
    { timeout: 600_000 },
  );
  const text = JSON.stringify(reply);
  const row = {
    name,
    arguments: args,
    elapsed_ms: performance.now() - started,
    reply_bytes: Buffer.byteLength(text),
    is_error: reply.isError === true,
  };
  calls.push(row);
  await writeFile(resolve(output, `call-${calls.length}.json`), text);
  if (reply.isError)
    throw new Error(`Tool failed: ${name}: ${text.slice(0, 2000)}`);
  return { value: plain(reply), text };
}
const command = (cmd) => JSON.stringify({ cmd, json: false, trim: false });
async function raw(cmd) {
  if (lane === "r2-exec")
    return call("execute_radare2_command", { path: target.path, command: cmd });
  if (lane === "r2pipe2")
    return call("radare2_command", { session_id: session, command: cmd });
  return call("run_command", { command: command(cmd), page_size: 10000 });
}
async function question() {
  const start = calls.length;
  if (lane === "ghidra") {
    for (const address of target.addresses)
      await call("procedure_pseudo_code", { procedure: address });
    await call("procedure_assembly", { procedure: target.addresses[0] });
  } else if (lane === "r2mcp-typed") {
    for (const address of target.addresses)
      await call("decompile_function", { address, page_size: 10000 });
    await call("disassemble_function", {
      address: target.addresses[0],
      page_size: 10000,
    });
  } else {
    const query = [
      ...target.addresses.map((address) => `pdg @ ${address}`),
      `pdf @ ${target.addresses[0]}`,
    ].join("; ");
    await raw(
      lane === "r2-exec"
        ? `e asm.dwarf=false;e scr.utf8=0;aa; ${query}`
        : query,
    );
  }
  const replies = await Promise.all(
    calls
      .slice(start)
      .map((_, index) =>
        readFile(resolve(output, `call-${start + index + 1}.json`), "utf8"),
      ),
  );
  return {
    reply_bytes: calls
      .slice(start)
      .reduce((sum, row) => sum + row.reply_bytes, 0),
    text: replies.join("\n"),
  };
}
try {
  await client.connect(transport);
  catalog = await client.listTools();
  await writeFile(resolve(output, "catalog.json"), JSON.stringify(catalog));
  if (lane === "ghidra") {
    await call("open_binary", { path: target.path, provider_id: "ghidra" });
    opened = true;
  } else if (lane === "r2pipe2") {
    const result = await call("start_radare2_session", {
      path: target.path,
      initial_commands: ["e asm.dwarf=false", "e scr.utf8=0", "aa"],
    });
    session = result.value.session_id ?? result.value.result?.session_id;
    if (!session) throw new Error(`Missing session ID: ${result.text}`);
  } else if (upstream) {
    await call("open_file", { file_path: target.path });
    opened = true;
    if (lane === "r2mcp-typed") await call("analyze", { level: 0 });
    else await raw("aa");
  }
  const first = await question();
  firstTaskMs = performance.now() - began;
  firstReplyBytes = first.reply_bytes;
  firstTexts = first.text;
  console.log(
    JSON.stringify({
      phase: "cold_done",
      lane,
      target: targetId,
      first_task_ms: firstTaskMs,
    }),
  );
  for (let index = 0; index < config.warm_repeats; index++) {
    const start = performance.now();
    const result = await question();
    warm.push({
      elapsed_ms: performance.now() - start,
      reply_bytes: result.reply_bytes,
    });
  }
} catch (cause) {
  failure = cause.stack ?? String(cause);
} finally {
  try {
    if (session) await call("close_radare2_session", { session_id: session });
    else if (opened)
      await call(lane === "ghidra" ? "close_binary" : "close_file", {});
  } catch (cause) {
    failure = `${failure ?? ""}\nCleanup: ${cause.stack ?? cause}`;
  }
  await client.close();
}
const after = await digest();
if (after !== before) failure = `${failure ?? ""}\nTarget changed`;
const report = {
  lane,
  target: targetId,
  path: target.path,
  sha256_before: before,
  sha256_after: after,
  first_task_ms: firstTaskMs,
  first_reply_bytes: firstReplyBytes,
  warm,
  catalog_bytes: catalog ? Buffer.byteLength(JSON.stringify(catalog)) : null,
  calls,
  total_ms: performance.now() - began,
  checks: firstTexts
    ? target.checks.map((text) => ({
        text,
        present: firstTexts.includes(text),
      }))
    : [],
  failure: failure ?? null,
};
await writeFile(resolve(output, "sdk.json"), JSON.stringify(report, null, 2));
await writeFile(resolve(output, "stderr.log"), Buffer.concat(diagnostics));
console.log(
  JSON.stringify({
    phase: "complete",
    lane,
    target: targetId,
    failure: failure ?? null,
  }),
);
if (failure) process.exitCode = 1;
