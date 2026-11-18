import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BinaryTarget } from "../../src/domain/binaryTargetTypes.js";
import type { JsonValue } from "../../src/domain/jsonValue.js";
import type { IdaMcpConnection } from "../../src/ida/IdaMcpConnection.js";
import { elf } from "../../src/domain/binaryTarget.fixture.js";

/** ELF machine numbers for the architectures a fixture target can declare. */
const ELF_MACHINE = { x86_64: 62, arm64: 183 } as const;

/** Create a test-owned executable and workspace parent without invoking an engine. */
export const createIdaTarget = async (
  architecture: keyof typeof ELF_MACHINE = "x86_64",
  availableArchitectures: readonly (keyof typeof ELF_MACHINE)[] = [
    architecture,
  ],
) => {
  const root = await mkdtemp(join(tmpdir(), "rea-ida-test-"));
  const path = join(root, "target.elf");
  const bytes = elf(2, 1, ELF_MACHINE[architecture]);
  await writeFile(path, bytes);
  const target: BinaryTarget = {
    path,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    kind: "executable",
    format: "elf",
    architecture,
    availableArchitectures: [...availableArchitectures],
  };
  return { root, target };
};

const nativeNames = [
  "list_funcs",
  "lookup_funcs",
  "find_regex",
  "decompile",
  "disasm",
  "callees",
  "xrefs_to",
];
const modernNames = [
  "idb_open",
  "idb_list",
  "idb_close",
  "server_health",
  "list_funcs",
  "lookup_funcs",
  "find_regex",
  "decompile",
  "disasm",
  "callees",
  "xrefs_to",
  "callgraph",
  "survey_binary",
];

/**
 * Stateful producer fixture at the real connection seam; no module mocking.
 * Attached mode serves the native ida-free-mcp protocol (metadata through
 * `ida://idb/metadata`); headless mode serves the database supervisor.
 */
export class RecordingIdaMcp implements IdaMcpConnection {
  readonly calls: {
    name: string;
    args: Readonly<Record<string, JsonValue>>;
  }[] = [];
  connects = 0;
  closes = 0;
  detaches = 0;
  inputSha256: string;
  inputPath: string;
  imageBase = "0x1000";
  pseudocode = "int main(void) { return 42; }";
  owned = true;
  active = true;
  database: string | undefined;
  failClose = false;
  beforeCall?: (
    name: string,
    args: Readonly<Record<string, JsonValue>>,
  ) => Promise<void>;
  overrideCall?: (
    name: string,
    args: Readonly<Record<string, JsonValue>>,
  ) => JsonValue | undefined;

  constructor(
    readonly target: BinaryTarget,
    readonly mode: "attached" | "headless" = "attached",
  ) {
    this.inputSha256 = target.sha256;
    this.inputPath = target.path;
  }
  /** Tool names the fake server advertises; defaults to the profile's full set. */
  tools?: readonly string[];
  readonly resources: string[] = [];
  /** The recorded input metadata a native attached server reports. */
  metadata(): JsonValue {
    return {
      path: `${this.inputPath}.i64`,
      module: "target.elf",
      sha256: this.inputSha256,
      base: this.imageBase,
    };
  }
  readResource = async (
    uri: string,
    options?: { readonly signal?: AbortSignal | undefined },
  ): Promise<JsonValue> => {
    this.resources.push(uri);
    await this.beforeCall?.(uri, {});
    options?.signal?.throwIfAborted();
    if (uri !== "ida://idb/metadata")
      throw new Error(`Unimplemented producer resource ${uri}`);
    const overridden = this.overrideCall?.(uri, {});
    return overridden === undefined ? this.metadata() : overridden;
  };
  async connect() {
    this.connects += 1;
    return this.tools ?? (this.mode === "attached" ? nativeNames : modernNames);
  }
  serverInfo() {
    return { name: "upstream-fixture", version: "sdk-version-is-not-ida" };
  }
  async close() {
    this.closes += 1;
  }
  detach() {
    this.detaches += 1;
  }
  async call(
    name: string,
    args: Readonly<Record<string, JsonValue>>,
  ): Promise<JsonValue> {
    this.calls.push({ name, args: structuredClone(args) });
    await this.beforeCall?.(name, args);
    const overridden = this.overrideCall?.(name, args);
    if (overridden !== undefined) return overridden;
    if (["idb_open", "idb_list", "idb_close", "server_health"].includes(name))
      return this.lifecycle(name, args);
    return this.read(name, args);
  }

  private read(
    name: string,
    args: Readonly<Record<string, JsonValue>>,
  ): JsonValue {
    const fn = { address: "0x1000", name: "main", size: "0x20" };
    const asm = {
      name: "main",
      start_ea: "0x1000",
      lines: [
        {
          address: "0x1000",
          instruction: "ret",
          comments: ["observed comment"],
        },
      ],
      return_type: "int",
      arguments: [],
    };
    const native = this.mode === "attached";
    switch (name) {
      case "list_funcs":
        return [
          {
            data: [{ addr: fn.address, name: fn.name, size: fn.size }],
            next_offset: null,
          },
        ];
      case "lookup_funcs":
        if (!Array.isArray(args.queries))
          throw new Error("Invalid fixture lookup queries");
        return args.queries.map((query) => ({
          query,
          fn: { addr: fn.address, name: fn.name, size: fn.size },
          error: null,
        }));
      case "decompile":
        return native
          ? {
              addr: fn.address,
              ok: true,
              pseudocode: this.pseudocode,
              lines: 1,
            }
          : { code: this.pseudocode, cursor: { done: true } };
      case "disasm":
        return native
          ? {
              asm: {
                name: asm.name,
                start_ea: asm.start_ea,
                lines: `main (.text @ ${asm.start_ea}):\n1000  ret`,
              },
              cursor: { done: true },
            }
          : { asm, cursor: { done: true } };
      case "callees":
        return [
          {
            callees: [{ addr: "0x2000", name: "puts", type: "external" }],
            more: false,
            ...(native ? { error: null } : {}),
          },
        ];
      case "xrefs_to":
        return [
          {
            xrefs: [
              {
                addr: "0x1004",
                type: "code",
                fn: { addr: fn.address, name: fn.name, size: fn.size },
              },
            ],
            more: false,
            ...(native ? { error: null } : {}),
          },
        ];
      case "find_regex":
        return {
          matches: [{ addr: "0x3000", string: "a.b\nC" }],
          cursor: { done: true },
        };
      default:
        throw new Error(`Unimplemented producer tool ${name}`);
    }
  }

  private lifecycle(
    name: string,
    args: Readonly<Record<string, JsonValue>>,
  ): JsonValue {
    switch (name) {
      case "idb_open": {
        if (
          typeof args.preferred_session_id !== "string" ||
          typeof args.input_path !== "string"
        )
          throw new Error("Missing lifecycle identity");
        this.database = args.preferred_session_id;
        this.inputPath = args.input_path;
        return {
          success: true,
          session: { session_id: this.database, input_path: this.inputPath },
        };
      }
      case "idb_list":
        return {
          sessions:
            this.database === undefined
              ? []
              : [
                  {
                    session_id: this.database,
                    input_path: this.inputPath,
                    owned: this.owned,
                    backend: "worker",
                    is_active: this.active,
                  },
                ],
        };
      case "server_health":
        return {
          status: "ok",
          input_path: this.inputPath,
          idb_path: `${this.inputPath}.i64`,
          module: "target.elf",
          imagebase: this.imageBase,
          auto_analysis_ready: true,
        };
      case "idb_close": {
        if (this.failClose) throw new Error("Worker release failed");
        const session_id = this.database;
        this.database = undefined;
        return {
          success: true,
          session_id: session_id ?? "missing",
          saved: null,
          owned: this.owned,
          backend: "worker",
        };
      }
      default:
        throw new Error(`Unimplemented producer tool ${name}`);
    }
  }
}
