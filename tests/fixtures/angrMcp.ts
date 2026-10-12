import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BinaryTarget } from "../../src/domain/binaryTargetTypes.js";
import type { JsonValue } from "../../src/domain/jsonValue.js";
import { AnalysisProtocolError } from "../../src/domain/analysisErrorCore.js";
import type { AngrMcpConnection } from "../../src/angr/AngrMcpConnection.js";
import { ANGR_REQUIRED_TOOLS } from "../../src/angr/AngrProviderCapabilities.js";
import { elf } from "../../src/domain/binaryTarget.fixture.js";

/** Create a test-owned executable without invoking an engine. */
export const createAngrTarget = async () => {
  const root = await mkdtemp(join(tmpdir(), "rea-angr-test-"));
  const path = join(root, "target.elf");
  const bytes = elf(2, 1, 62);
  await writeFile(path, bytes);
  const target: BinaryTarget = {
    path,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    kind: "executable",
    format: "elf",
    architecture: "x86_64",
    availableArchitectures: ["x86_64"],
  };
  return { root, target };
};

const MAIN = {
  address: "0x1000",
  name: "main",
  is_plt: false,
  is_syscall: false,
};
const HELPER = {
  address: "0x1040",
  name: "helper",
  is_plt: false,
  is_syscall: false,
};
const PUTS = {
  address: "0x2000",
  name: "puts",
  is_plt: true,
  is_syscall: false,
};
const FUNCTIONS = [MAIN, HELPER, PUTS];

/** Stateful producer fixture at the real connection seam; no module mocking. */
export class RecordingAngrMcp implements AngrMcpConnection {
  readonly calls: {
    name: string;
    args: Readonly<Record<string, JsonValue>>;
  }[] = [];
  connects = 0;
  closes = 0;
  projectId = "p1";
  loadedPath: string;
  openProjects = new Set<string>();
  pseudocode = "int main(void) { return 42; }";
  tools?: readonly string[];
  beforeCall?: (
    name: string,
    args: Readonly<Record<string, JsonValue>>,
  ) => Promise<void>;
  overrideCall?: (
    name: string,
    args: Readonly<Record<string, JsonValue>>,
  ) => JsonValue | undefined;

  constructor(readonly target: BinaryTarget) {
    this.loadedPath = target.path;
  }
  async connect() {
    this.connects += 1;
    return this.tools ?? [...ANGR_REQUIRED_TOOLS];
  }
  serverInfo() {
    return { name: "angr-mcp", version: "fixture" };
  }
  async close() {
    this.closes += 1;
  }
  async call(
    name: string,
    args: Readonly<Record<string, JsonValue>>,
  ): Promise<JsonValue> {
    this.calls.push({ name, args: structuredClone(args) });
    await this.beforeCall?.(name, args);
    const overridden = this.overrideCall?.(name, args);
    if (overridden !== undefined) return overridden;
    if (name === "load_binary") {
      this.openProjects.add(this.projectId);
      return {
        project_id: this.projectId,
        binary_path: this.loadedPath,
        arch: "AMD64",
        bits: 64,
        endianness: "little",
        entry_point: "0x1000",
        filename: this.loadedPath,
      };
    }
    if (name === "close_project") {
      const closed = this.openProjects.delete(String(args.project_id));
      return { project_id: args.project_id ?? null, closed };
    }
    if (!this.openProjects.has(String(args.project_id)))
      throw new AnalysisProtocolError(
        `angr MCP tool failed: Project not found: ${String(args.project_id)}`,
      );
    return this.read(name, args);
  }

  private read(
    name: string,
    args: Readonly<Record<string, JsonValue>>,
  ): JsonValue {
    const projectId = this.projectId;
    switch (name) {
      case "get_cfg":
        return {
          project_id: projectId,
          status: "success",
          nodes: 5,
          edges: 4,
          normalized: true,
          memory_data_count: 2,
          jump_table_count: 0,
          functions_discovered: FUNCTIONS.length,
        };
      case "list_functions": {
        const offset = Number(args.offset ?? 0);
        const limit = Number(args.limit ?? 100);
        return {
          project_id: projectId,
          total: FUNCTIONS.length,
          offset,
          limit,
          functions: FUNCTIONS.slice(offset, offset + limit),
        };
      }
      case "get_function_info": {
        const fn = FUNCTIONS.find(
          (candidate) =>
            candidate.name === args.name || candidate.address === args.address,
        );
        if (fn === undefined)
          throw new AnalysisProtocolError(
            `angr MCP tool failed: ${
              typeof args.name === "string"
                ? `No function named ${JSON.stringify(args.name)}.`
                : `No function found at address ${String(args.address)}.`
            }`,
          );
        return {
          project_id: projectId,
          ...fn,
          size: 32,
          is_simprocedure: false,
          returning: true,
          binary_name: "target.elf",
          num_blocks: 2,
          cyclomatic_complexity: 1,
          prototype: "int main(int argc, char **argv)",
          decompilation_block_limit: 50000,
        };
      }
      case "decompile_function":
        return {
          project_id: projectId,
          function_address: args.address ?? null,
          function_name: "main",
          code: this.pseudocode,
        };
      case "get_basic_blocks":
        return {
          project_id: projectId,
          function_address: args.function_address ?? null,
          function_name:
            FUNCTIONS.find((fn) => fn.address === args.function_address)
              ?.name ?? "main",
          block_count: 2,
          blocks: [
            {
              address: "0x1010",
              size: 16,
              instruction_count: 1,
              instructions: [
                { address: "0x1010", mnemonic: "ret", op_str: "", bytes: "c3" },
              ],
            },
            {
              address: "0x1000",
              size: 16,
              instruction_count: 1,
              instructions: [
                {
                  address: "0x1000",
                  mnemonic: "call",
                  op_str: "0x2000",
                  bytes: "e8fb0f0000",
                },
              ],
            },
          ],
        };
      case "get_xrefs":
        return {
          project_id: projectId,
          address: args.address ?? null,
          direction: "to",
          count: 1,
          xrefs: [
            {
              from_address: "0x1008",
              to_address: args.address ?? null,
              type: "offset",
              block_address: "0x1000",
            },
          ],
        };
      case "get_strings":
        return {
          project_id: projectId,
          count: 2,
          strings: [
            {
              address: "0x3000",
              content: "Username: ",
              size: 11,
              type: "ascii",
            },
            { address: "0x3010", content: "a.b", size: 4, type: "ascii" },
          ],
        };
      case "get_callgraph":
        return {
          project_id: projectId,
          node_count: 3,
          edge_count: 2,
          nodes: FUNCTIONS.map(({ address, name, is_plt }) => ({
            address,
            name,
            is_plt,
          })),
          edges: [
            { from: "0x1000", to: "0x2000" },
            { from: "0x1040", to: "0x1000" },
          ],
        };
      default:
        throw new AnalysisProtocolError(`Unmodeled angr MCP tool ${name}`);
    }
  }
}
