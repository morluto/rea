import { promisify } from "node:util";

const dossier = {
  pseudocode: "int main(){}",
  assembly: ["ret"],
  procedure: { body: { available: false } },
};

/** Shared stand-in state for the IDA verifier cleanup driver. */
export const idaCleanupState = {
  failClose: false,
  events: [],
  target: "",
  report: "",
  primary: new Error("inert analyze failure"),
  cleanup: new Error("inert close_binary failure"),
};

const evidence = {
  provider: { id: "ida", version: "1" },
  analysis_profile: {
    parameters: { cache_policy: "live", engine_version: null },
  },
  limitations: ["inert"],
  locations: [{ kind: "artifact-path" }],
  operation: "analyze_function",
  relationship_coverage: { status: "unknown" },
  normalized_result: dossier,
};

export { promisify };
export function parseArgs() {
  return {
    values: {
      target: idaCleanupState.target,
      report: idaCleanupState.report,
      procedure: "main",
      "second-procedure": "helper",
      "second-marker": "marker",
    },
  };
}

export const execFile = Object.assign(
  () => {
    throw new Error("Spawning forbidden");
  },
  {
    [promisify.custom]: async () => ({ stdout: JSON.stringify(evidence) }),
  },
);

export class Client {
  async connect() {
    idaCleanupState.events.push("connect");
  }
  async callTool({ name }) {
    idaCleanupState.events.push(name);
    if (name === "analyze_function") throw idaCleanupState.primary;
    if (name === "close_binary" && idaCleanupState.failClose)
      throw idaCleanupState.cleanup;
    return { structuredContent: {} };
  }
  async close() {
    idaCleanupState.events.push("client.close");
  }
}

export class StdioClientTransport {
  async close() {
    idaCleanupState.events.push("transport.close");
  }
}

export function assertFeatureTrace() {}
export function findMappedNonFunction() {}
export function requireMcpToolError() {}
export const withVerifierResourceOwner = (operation) => operation({});
export const toolContract = () => ({
  outputSchema: { parse: (value) => value },
});
export const evidenceSchema = { parse: (value) => value };
export const functionDossierSchema = { parse: (value) => value };
export const readIdaConfiguration = async () => ({
  ok: true,
  value: { mode: "attached", protocol: "native", timeoutMs: 100 },
});
export const idaCompatibilityProfile = () => ({ protocol: "native" });
export function createIdaMcpConnection() {
  throw new Error("upstream never reached");
}
export const idaAddressSchema = { parse: (value) => value };
