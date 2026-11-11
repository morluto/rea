import * as fs from "node:fs/promises";
import { promisify } from "node:util";

const graph = {
  target_sha256: "a".repeat(64),
  seed: "0x1000",
  procedures: [],
  nodes: [
    {
      id: "c",
      evidence_id: "ev_" + "b".repeat(64),
      operation: { opcode: "CALL", inputs: [] },
    },
    {
      id: "p",
      evidence_id: "ev_" + "b".repeat(64),
      kind: "parameter",
      parameter: { ordinal: 0 },
    },
    {
      id: "r",
      evidence_id: "ev_" + "b".repeat(64),
      operation: { opcode: "RETURN", inputs: [{ location: "0x2000" }] },
    },
  ],
  edges: [
    {
      kind: "argument-binding",
      source: "c",
      target: "p",
      status: "derived",
      input_index: 1,
    },
    {
      kind: "parameter-use",
      source: "p",
      target: "r",
      status: "derived",
      input_index: 0,
    },
    {
      kind: "return-binding",
      source: "r",
      target: "c",
      status: "derived",
      input_index: 1,
    },
  ],
};
const evidence = {
  operation: "trace_native_values",
  provider: { id: "rea-workflow" },
  analysis_profile: {
    provider: { id: "rea-workflow" },
    parameters: {
      upstream_analysis_profile: {
        provider: { id: "ghidra" },
        digest: "c".repeat(64),
      },
    },
  },
  normalized_result: graph,
};

/** Shared stand-in state for one native verifier cleanup process. */
export const nativeCleanupState = {
  fault: "none",
  events: [],
  workspace: undefined,
  clientCloseCalls: 0,
  transportCloseCalls: 0,
  primary: new Error("inert connection failure"),
  cleanup: new Error("inert client close failure"),
  transportFailure: new Error("inert transport close failure"),
};

export const mkdir = fs.mkdir;
export const readdir = fs.readdir;
export const mkdtemp = async (...args) => {
  const directory = await fs.mkdtemp(...args);
  nativeCleanupState.workspace = directory;
  return directory;
};
export const rm = async (...args) => {
  nativeCleanupState.events.push("rm");
  return fs.rm(...args);
};

export const execFile = Object.assign(
  () => {
    throw new Error("No child process authorized");
  },
  {
    [promisify.custom]: async () => {
      if (nativeCleanupState.fault === "early")
        throw nativeCleanupState.primary;
      return { stdout: JSON.stringify(evidence) };
    },
  },
);

export class Client {
  async connect() {
    nativeCleanupState.events.push("connect");
    throw nativeCleanupState.primary;
  }
  async close() {
    nativeCleanupState.events.push("client.close");
    nativeCleanupState.clientCloseCalls += 1;
    if (
      ["client", "both"].includes(nativeCleanupState.fault) &&
      nativeCleanupState.clientCloseCalls === 1
    )
      throw nativeCleanupState.cleanup;
  }
}

export class StdioClientTransport {
  async close() {
    nativeCleanupState.events.push("transport.close");
    nativeCleanupState.transportCloseCalls += 1;
    if (
      ["transport", "both"].includes(nativeCleanupState.fault) &&
      nativeCleanupState.transportCloseCalls === 1
    )
      throw nativeCleanupState.transportFailure;
  }
}

export const parseEvidence = (value) => value;
export const analysisProfileSchema = { parse: (value) => value };
export const nativeValueTraceSchema = { parse: (value) => value };
export function requireMcpEvidenceBundle() {}
export function requireMcpLifecycleResult() {}
export function requireMcpOutput() {}
export function verifyGhidraBoundaries() {}
export function verifyLegacyValueScopeSnapshot() {}
export function verifyGhidraProjectIdentity() {}
export function verifyGhidraSocketBoundary() {}
