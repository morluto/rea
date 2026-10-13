import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BinaryTarget } from "../../src/domain/binaryTargetTypes.js";
import type { JsonValue } from "../../src/domain/jsonValue.js";
import { AnalysisProtocolError } from "../../src/domain/analysisErrorCore.js";
import type { AngrMcpConnection } from "../../src/angr/AngrMcpConnection.js";
import {
  ANGR_FLAVOR_TOOLS,
  ANGR_REQUIRED_TOOLS,
} from "../../src/angr/AngrProviderCapabilities.js";
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
  /** Digest the fixture server reports; undefined models an angr without one. */
  loadedSha256: string | undefined;
  openProjects = new Set<string>();
  pseudocode = "int main(void) { return 42; }";
  flavor = "pseudocode";
  /** Names applied through rename, by function address. */
  readonly names = new Map<string, string>(
    FUNCTIONS.map((fn) => [fn.address, fn.name]),
  );
  readonly comments = new Map<string, string>();
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
    this.loadedSha256 = target.sha256;
  }
  async connect() {
    this.connects += 1;
    return this.tools ?? [...ANGR_REQUIRED_TOOLS, ...ANGR_FLAVOR_TOOLS];
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
        ...(this.loadedSha256 === undefined
          ? {}
          : { sha256: this.loadedSha256 }),
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
          functions: FUNCTIONS.slice(offset, offset + limit).map((fn) => ({
            ...fn,
            name: this.names.get(fn.address) ?? fn.name,
          })),
        };
      }
      case "get_function_info": {
        const fn = FUNCTIONS.map((candidate) => ({
          ...candidate,
          name: this.names.get(candidate.address) ?? candidate.name,
        })).find(
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
          function_name: this.names.get(String(args.address)) ?? "main",
          code: this.pseudocode,
        };
      case "get_basic_blocks":
        return this.basicBlocks(args);
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
      case "get_decompilation_flavor":
      case "set_decompilation_flavor":
        return this.flavorTool(name, args);
      case "rename":
      case "set_type":
      case "set_comments":
        return this.edit(name, args);
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

  private basicBlocks(args: Readonly<Record<string, JsonValue>>): JsonValue {
    const projectId = this.projectId;
    return {
      project_id: projectId,
      function_address: args.function_address ?? null,
      function_name:
        this.names.get(String(args.function_address)) ??
        FUNCTIONS.find((fn) => fn.address === args.function_address)?.name ??
        "main",
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
  }

  private flavorTool(
    name: string,
    args: Readonly<Record<string, JsonValue>>,
  ): JsonValue {
    if (name === "get_decompilation_flavor")
      return {
        project_id: this.projectId,
        flavor: this.flavor,
        available_flavors: ["pseudocode", "rust", "go"],
        detected_language: "c",
        detected_compiler: "gcc",
        detection_confidence: "medium",
      };
    const flavor = String(args.flavor);
    if (!["pseudocode", "rust", "go"].includes(flavor))
      throw new AnalysisProtocolError(
        `angr MCP tool failed: Unknown decompilation flavor ${JSON.stringify(flavor)}. Valid flavors: pseudocode, rust, go.`,
      );
    const previous = this.flavor;
    this.flavor = flavor;
    return { project_id: this.projectId, previous_flavor: previous, flavor };
  }

  /** Model angr's batch edit tools: per-item results, counts, and affected functions. */
  private edit(
    name: string,
    args: Readonly<Record<string, JsonValue>>,
  ): JsonValue {
    const items = Array.isArray(args.items) ? args.items : [];
    const dryRun = args.dry_run === true;
    const results: Record<string, JsonValue>[] = [];
    const touched = new Set<string>();
    items.forEach((raw, index) => {
      const item = raw as Record<string, JsonValue>;
      const kind = String(item.kind);
      const fnKey = String(item.function ?? item.address ?? item.name ?? "");
      const fn = FUNCTIONS.find(
        (candidate) =>
          candidate.address === fnKey ||
          (this.names.get(candidate.address) ?? candidate.name) === fnKey,
      );
      const entry: Record<string, JsonValue> = {
        index,
        kind,
        status: "ok",
        function_address: fn?.address ?? null,
        function_name:
          fn === undefined ? null : (this.names.get(fn.address) ?? fn.name),
        target: null,
        old: null,
        new: null,
        detail: {},
        error: null,
      };
      const fail = (error: string) => {
        entry.status = "error";
        entry.error = error;
      };
      if (name === "rename") {
        const newName = String(item.new_name);
        if (newName === "__reject__")
          fail("Name '__reject__' is not a valid identifier.");
        else if (kind === "function" && fn !== undefined) {
          entry.old = this.names.get(fn.address) ?? fn.name;
          entry.target = entry.old;
          entry.new = newName;
          if (entry.old === newName) entry.status = "unchanged";
          else if (!dryRun) this.names.set(fn.address, newName);
        } else if (kind === "variable" && fn !== undefined) {
          if (item.name === "absent_variable")
            fail(`No variable named 'absent_variable' in ${fnKey}.`);
          else {
            entry.target = String(item.name);
            entry.old = String(item.name);
            entry.new = newName;
            entry.detail = { storage: "stack", offset: -8 };
          }
        } else if (kind === "global") {
          entry.target = String(item.address);
          entry.old = "unk_3000";
          entry.new = newName;
          entry.function_address = null;
          entry.function_name = null;
        } else fail(`No function named ${JSON.stringify(fnKey)}.`);
      } else if (name === "set_type") {
        if (fn === undefined && kind !== "global")
          fail(`No function named ${JSON.stringify(fnKey)}.`);
        else {
          entry.target =
            kind === "global"
              ? String(item.address)
              : String(item.name ?? fnKey);
          entry.old =
            kind === "function" ? "int main(int argc, char **argv)" : "char";
          entry.new = String(item.type);
          if (kind === "global") {
            entry.function_address = null;
            entry.function_name = null;
          }
        }
      } else {
        const address =
          kind === "function" ? (fn?.address ?? "") : String(item.address);
        const comment = String(item.comment ?? "");
        if (address === "") fail(`No function named ${JSON.stringify(fnKey)}.`);
        else if (comment === "__reject__") fail("Comment rejected by fixture.");
        else {
          entry.target = address;
          entry.old = this.comments.get(address) ?? null;
          entry.new = comment;
          if (!dryRun) {
            if (comment === "") this.comments.delete(address);
            else this.comments.set(address, comment);
          }
          entry.detail = { snapped_from: null, rendered_inline: true };
        }
      }
      if (entry.status === "ok" && typeof entry.function_address === "string")
        touched.add(entry.function_address);
      results.push(entry);
    });
    const count = (status: string) =>
      results.filter((entry) => entry.status === status).length;
    return {
      project_id: this.projectId,
      dry_run: dryRun,
      total: results.length,
      succeeded: count("ok"),
      unchanged: count("unchanged"),
      failed: count("error"),
      skipped: count("skipped"),
      results,
      functions_affected: [...touched].sort(),
    };
  }
}
