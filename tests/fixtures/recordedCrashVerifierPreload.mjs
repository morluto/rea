// Runs the real recorded-crash verifier on any host. Its Linux x64 guard, the
// /proc pid_max read, the private fixture root, the fixture tooling, the
// sentinel, the MCP owners, the CLI and the lineage observation are authored
// here, so the verification fails early and only the verifier's ownership
// handling is observed, in order, in an event log. The public session helper
// runs for real with authored SDK owners.
import { registerHooks } from "node:module";

Object.defineProperty(process, "platform", { value: "linux" });
Object.defineProperty(process, "arch", { value: "x64" });

const script = "/scripts/verify-recorded-crash.mjs";
const session = "/scripts/verify/recorded-crash/public.mjs";
const scenario = process.env.REA_CORE_TEST_SCENARIO ?? "";
const events = JSON.stringify(process.env.REA_CORE_TEST_EVENTS);
const realVerifierRun = JSON.stringify(
  new URL("../../scripts/lib/verifier-run.mjs", import.meta.url).href,
);
const record = (kind) =>
  `appendFileSync(${events}, ${JSON.stringify(kind)} + "\\n");`;
const refused = (owner) =>
  scenario === `${owner}-close-refused` ||
  (owner === "transport" && scenario === "connect-and-close-refused");
const refusal = (owner) =>
  refused(owner) ? `throw new Error("authored ${owner} close failure");` : "";
const lineage =
  scenario === "lineage-unverified"
    ? '{ status: "unavailable", reason: "authored lineage unavailability", descendants: [] }'
    : '{ status: "verified", descendants: [] }';
const connection =
  scenario === "connect-refused" || scenario === "connect-and-close-refused"
    ? 'throw new Error("authored connection failure");'
    : "";
const prerequisite =
  scenario === "prerequisite-unavailable"
    ? 'if (command === "gcc") throw new Error("authored gcc absence");'
    : "";
const unreachable = (name) =>
  `export const ${name} = () => { throw new Error("The authored verification never reaches ${name}"); };`;

const scriptMocks = {
  "node:fs/promises": `import * as fs from "node:fs/promises";
export const { writeFile, copyFile } = fs;
export const readFile = (path, ...rest) =>
  path === "/proc/sys/kernel/pid_max"
    ? Promise.resolve("4194304\\n")
    : fs.readFile(path, ...rest);`,
  "../dist/process/PrivateRuntimeRoot.js": `import { appendFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
export class PrivateRuntimeRoot {
  static async create({ prefix }) {
    const path = await mkdtemp(join(tmpdir(), prefix));
    appendFileSync(${events}, "root-create " + path + "\\n");
    return new PrivateRuntimeRoot(path);
  }
  constructor(path) { this.path = path; }
  async close() {
    ${record("root-close")}
    await rm(this.path, { recursive: true, force: true });
  }
}`,
  "./lib/verifier-run.mjs": `import { appendFileSync } from "node:fs";
export { assertVerifierCleanupComplete } from ${realVerifierRun};
export const createVerifierRun = () => ({ run_id: "authored-run" });
export const completeVerifierRun = async (run) => {
  ${record("lineage-observe")}
  return { ...run, process_lineage: ${lineage} };
};`,
  "./lib/verify-package-core.mjs": `export const verifyCompleteToolCatalog = async () => [
  "inspect_binary_layout",
  "inspect_recorded_crash",
  "inspect_evm_interface",
];`,
  "./verify/recorded-crash/fixtures.mjs": `import { appendFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
export async function fixtureCommand(command) {
  ${prerequisite}
  return "{}";
}
export async function createRecordedCore(options) {
  const core = join(options.root, "recording.core");
  await writeFile(core, "authored core");
  return core;
}
export async function startCoreSentinel() {
  return {
    pid: 4242,
    assertAlive() {},
    async close() { ${record("sentinel-close")} ${refusal("sentinel")} },
  };
}`,
  "./verify/recorded-crash/trace.mjs": unreachable("verifyCoreInspectionTrace"),
};

const sessionMocks = {
  "node:child_process": `import { promisify } from "node:util";
export const execFile = Object.assign(() => {}, {
  [promisify.custom]: () => Promise.reject(new Error("authored CLI failure")),
});`,
  "@modelcontextprotocol/client": `import { appendFileSync } from "node:fs";
export class Client {
  async connect() { ${connection} }
  async listTools() { return { tools: [{ name: "inspect_recorded_crash" }] }; }
  async close() { ${record("client-close")} ${refusal("client")} }
}`,
  "@modelcontextprotocol/client/stdio": `import { appendFileSync } from "node:fs";
export class StdioClientTransport {
  async close() { ${record("transport-close")} ${refusal("transport")} }
}`,
  "../../../dist/domain/evidence.js":
    "export const parseEvidence = (value) => value;",
  "../../../dist/domain/native/recordedCrash.js":
    "export const recordedCrashSchema = { parse: (value) => value };",
  "../../lib/mcp-verifier-results.mjs": unreachable("mcpTextValue"),
};

registerHooks({
  resolve(specifier, context, next) {
    const mocks = context.parentURL?.endsWith(script)
      ? scriptMocks
      : context.parentURL?.endsWith(session)
        ? sessionMocks
        : undefined;
    if (mocks !== undefined && Object.hasOwn(mocks, specifier))
      return {
        shortCircuit: true,
        url: "data:text/javascript," + encodeURIComponent(mocks[specifier]),
      };
    return next(specifier, context);
  },
});
