import { parseTree, visit, type Node, type ParseError } from "jsonc-parser";
import { err, ok, type Result } from "../result.js";

interface SolcJsonError {
  readonly reason: "format" | "resource";
  readonly message: string;
}

/** Pre-allocation ceilings within the existing 256 MiB EVM worker heap.
 * Node cost is conservatively estimated at 512 bytes: 65,536 nodes reserve
 * about 32 MiB per tree, leaving room for carrier text, metadata and inference.
 * This is an allocation estimate, not a measured process-memory guarantee.
 */
export const SOLC_JSON_LIMITS = {
  inputBytes: 4 * 1024 * 1024,
  depth: 128,
  nodes: 65_536,
  estimatedBytesPerNode: 512,
} as const;
const strictOptions = {
  disallowComments: true,
  allowTrailingComma: false,
  allowEmptyContent: false,
};
const failure = (reason: SolcJsonError["reason"], message: string) =>
  err({ reason, message });
export const child = (
  node: Node | undefined,
  name: string,
): Node | undefined =>
  node?.type === "object"
    ? node.children?.find((property) => property.children?.[0]?.value === name)
        ?.children?.[1]
    : undefined;
/** Validate syntax, duplicate identities and depth before allocating the AST. */
export function strictTree(text: string): Result<Node, SolcJsonError> {
  let depth = 0;
  let invalid = false;
  let excessive: "depth" | "nodes" | null = null;
  let nodes = 0;
  const account = (count: number) => {
    nodes += count;
    if (nodes > SOLC_JSON_LIMITS.nodes) {
      excessive = "nodes";
      throw new Error("nodes");
    }
  };
  const objects: Set<string>[] = [];
  try {
    visit(
      text,
      {
        onObjectBegin: () => {
          account(1);
          if (++depth > SOLC_JSON_LIMITS.depth) {
            excessive = "depth";
            throw new Error("depth");
          }
          objects.push(new Set());
          return true;
        },
        onObjectProperty: (name) => {
          account(2); // Property node plus its string-key node.
          const current = objects.at(-1);
          if (current?.has(name)) invalid = true;
          current?.add(name);
        },
        onObjectEnd: () => {
          depth--;
          objects.pop();
        },
        onArrayBegin: () => {
          account(1);
          if (++depth > SOLC_JSON_LIMITS.depth) {
            excessive = "depth";
            throw new Error("depth");
          }
          return true;
        },
        onArrayEnd: () => {
          depth--;
        },
        onLiteralValue: () => {
          account(1);
        },
        onError: () => {
          invalid = true;
        },
      },
      strictOptions,
    );
  } catch (cause) {
    if (!excessive) throw cause;
  }
  if (excessive)
    return failure(
      "resource",
      excessive === "depth"
        ? `Compiler JSON nesting exceeds ${SOLC_JSON_LIMITS.depth} levels`
        : `Compiler JSON exceeds ${SOLC_JSON_LIMITS.nodes} AST nodes`,
    );
  if (invalid)
    return failure(
      "format",
      "Compiler JSON contains malformed syntax, comments or duplicate properties",
    );
  const errors: ParseError[] = [];
  const tree = parseTree(text, errors, strictOptions);
  return tree === undefined || errors.length > 0
    ? failure("format", "Malformed compiler JSON")
    : ok(tree);
}

/** Derive metadata facts from the retained source, preserving exact settings text. */
export function compilerMetadataFacts(raw: string | null): {
  parse_status: "absent" | "malformed" | "resource-limited" | "valid";
  compiler_version: string | null;
  settings_json: string | null;
} {
  const unavailable = { compiler_version: null, settings_json: null };
  if (raw === null) return { ...unavailable, parse_status: "absent" };
  if (Buffer.byteLength(raw) > SOLC_JSON_LIMITS.inputBytes)
    return { ...unavailable, parse_status: "resource-limited" };
  const tree = strictTree(raw);
  if (!tree.ok)
    return {
      ...unavailable,
      parse_status:
        tree.error.reason === "resource" ? "resource-limited" : "malformed",
    };
  if (tree.value.type !== "object")
    return { ...unavailable, parse_status: "malformed" };
  const version = child(child(tree.value, "compiler"), "version");
  const settings = child(tree.value, "settings");
  return {
    parse_status: "valid",
    compiler_version:
      version?.type === "string" ? (version.value as string) : null,
    settings_json:
      settings === undefined
        ? null
        : raw.slice(settings.offset, settings.offset + settings.length),
  };
}
