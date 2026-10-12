import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const { values } = parseArgs({
  options: {
    "runtime-root": { type: "string" },
    path: { type: "string" },
    providers: { type: "string" },
    output: { type: "string" },
  },
});
if (
  !values["runtime-root"] ||
  !values.path ||
  !values.providers ||
  !values.output
)
  throw new Error(
    "Use --runtime-root ABS --path ABS --providers JSON --output NEW_ABS_DIR",
  );
const selected = JSON.parse(await readFile(values.providers, "utf8"));
const expectedName = selected.REA_GHIDRA_DISABLED_ANALYZERS;
if (!expectedName)
  throw new Error(
    "The probe requires an explicitly selected invalid analyzer name",
  );
const digest = async () => {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(values.path)) hash.update(chunk);
  return hash.digest("hex");
};
const before = await digest();
await mkdir(values.output, { mode: 0o700 });
const file = await open(values.path, "r");
let address;
try {
  const header = Buffer.alloc(32);
  const { bytesRead } = await file.read(header, 0, header.length, 0);
  if (
    bytesRead !== 32 ||
    header.subarray(0, 6).toString("hex") !== "7f454c460201"
  )
    throw new Error(
      "This counterexample uses a real ELF64 little-endian application",
    );
  address = `0x${header.readBigUInt64LE(24).toString(16)}`;
} finally {
  await file.close();
}
const client = new Client({ name: "rea-analyzer-verification", version: "1" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [resolve(values["runtime-root"], "scripts/rea.mjs"), "mcp"],
  env: { ...process.env, ...selected },
  stderr: "pipe",
});
const calls = [];
const call = async (name, arguments_) => {
  const reply = await client.callTool(
    { name, arguments: arguments_ },
    { timeout: 600_000 },
  );
  await writeFile(
    resolve(values.output, `call-${calls.length + 1}.json`),
    JSON.stringify(reply),
  );
  calls.push({ name, is_error: reply.isError === true });
  return reply;
};
let rejected = false;
let named = false;
let failure = null;
try {
  await client.connect(transport);
  const opened = await call("open_binary", {
    path: values.path,
    provider_id: "ghidra",
  });
  const reply = opened.isError
    ? opened
    : await call("resolve_containing_procedure", { address });
  rejected = reply.isError === true;
  named = rejected && JSON.stringify(reply).includes(expectedName);
} catch (error) {
  failure = String(error);
} finally {
  try {
    await call("close_binary", {});
  } catch (error) {
    failure = `${failure ?? ""} close: ${String(error)}`;
  }
  await client.close();
}
const after = await digest();
const report = {
  target_sha256: before,
  target_sha256_after: after,
  expected_analyzer: expectedName,
  rejected,
  rejection_names_requested_analyzer: named,
  failure,
  calls,
  oracle:
    "A syntactically valid but nonexistent analyzer must produce a meaningful public refusal, not successful Evidence claiming that preset. A not-found procedure still means Ghidra reached readiness.",
};
await writeFile(
  resolve(values.output, "summary.json"),
  JSON.stringify(report, null, 2),
);
process.stdout.write(JSON.stringify(report) + "\n");
if (!rejected || !named || failure || before !== after) process.exitCode = 1;
