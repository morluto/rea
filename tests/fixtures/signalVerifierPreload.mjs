// Runs the real signal recording verifier on any host. Its Linux guard, the
// /proc limits read, the private fixture root, the MCP owners and the lineage
// observation are authored here, so the verification fails at connection and
// only the verifier's cleanup ownership is observed, in order, in an event log.
import { registerHooks } from "node:module";

Object.defineProperty(process, "platform", { value: "linux" });

const script = "/scripts/verify-signal-recording.mjs";
const scenario = process.env.REA_SIGNAL_TEST_SCENARIO ?? "";
const events = JSON.stringify(process.env.REA_SIGNAL_TEST_EVENTS);
const realVerifierRun = JSON.stringify(
  new URL("../../scripts/lib/verifier-run.mjs", import.meta.url).href,
);
const record = (kind) =>
  `appendFileSync(${events}, ${JSON.stringify(kind)} + "\\n");`;
const refusal = (owner) =>
  scenario === `${owner}-close-refused`
    ? `throw new Error("authored ${owner} close failure");`
    : "";
const limits =
  scenario === "limits-unreadable"
    ? 'Promise.reject(new Error("authored limits read failure"))'
    : 'Promise.resolve("Limit Soft Limit Hard Limit Units\\nMax address space unlimited unlimited bytes\\n")';
const lineage =
  scenario === "lineage-unverified"
    ? '{ status: "unavailable", reason: "authored lineage unavailability", descendants: [] }'
    : '{ status: "verified", descendants: [] }';

const mocks = {
  "node:fs/promises": `import * as fs from "node:fs/promises";
export const { writeFile, readdir } = fs;
export const readFile = (path, ...rest) =>
  path === "/proc/self/limits" ? ${limits} : fs.readFile(path, ...rest);`,
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
  "../dist/domain/evidence.js":
    "export const parseEvidence = (value) => value;",
  "./lib/mcp-verifier-results.mjs": `const unreachable = () => {
  throw new Error("The authored connection never succeeds");
};
export const requireMcpEvidenceBundle = unreachable;
export const requireMcpOutput = unreachable;
export const requireMcpToolError = unreachable;`,
  "./lib/verifier-run.mjs": `import { appendFileSync } from "node:fs";
export { assertVerifierCleanupComplete } from ${realVerifierRun};
export const createVerifierRun = () => ({ run_id: "authored-run" });
export const completeVerifierRun = async (run) => {
  ${record("lineage-observe")}
  return { ...run, process_lineage: ${lineage} };
};`,
  "@modelcontextprotocol/client": `import { appendFileSync } from "node:fs";
export class Client {
  async connect() { throw new Error("authored connection failure"); }
  async close() { ${record("client-close")} ${refusal("client")} }
}`,
  "@modelcontextprotocol/client/stdio": `import { appendFileSync } from "node:fs";
export class StdioClientTransport {
  async close() { ${record("transport-close")} ${refusal("transport")} }
}`,
};

registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL?.endsWith(script) && Object.hasOwn(mocks, specifier))
      return {
        shortCircuit: true,
        url: "data:text/javascript," + encodeURIComponent(mocks[specifier]),
      };
    return next(specifier, context);
  },
});
