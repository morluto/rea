import type { Node } from "jsonc-parser";
import {
  child,
  compilerMetadataFacts,
  SOLC_JSON_LIMITS,
  strictTree,
} from "./solcCompilerJson.js";
import {
  compilerSelectionSchema,
  type CompilerSelection,
  type SolcArtifact,
} from "./solcArtifact.js";
import { inspectSolcBytecodeObject } from "./solcBytecodeObject.js";
import { err, ok, type Result } from "../result.js";

export interface SolcArtifactSelectionError {
  readonly reason: "format" | "selection" | "resource";
  readonly message: string;
  readonly compiler_diagnostics?: NonNullable<SolcArtifact["diagnostics"]>;
}
const failure = (
  reason: SolcArtifactSelectionError["reason"],
  message: string,
) => err({ reason, message });
const range = (node: Node) => ({
  start: node.offset,
  end: node.offset + node.length,
  unit: "utf16-code-unit" as const,
});
const nullableRange = (node: Node | undefined) =>
  node === undefined ? null : range(node);
const properties = (node: Node): readonly Node[] => node.children ?? [];
const pointer = (value: string): string =>
  value.replaceAll("~", "~0").replaceAll("/", "~1");

function references(
  node: Node | undefined,
  kind: "link" | "immutable",
  text: string,
  byteLength: number | null,
): Result<SolcArtifact["link_references"], SolcArtifactSelectionError> {
  if (node === undefined) return ok(null);
  if (node.type !== "object")
    return failure("format", `${kind}References must be an object`);
  const output: NonNullable<SolcArtifact["link_references"]> = [];
  function spans(
    array: Node,
    source: string | null,
    library: string | null,
    immutable: string | null,
  ): boolean {
    if (array.type !== "array") return false;
    for (const item of properties(array)) {
      if (item.type !== "object") return false;
      const startNode = child(item, "start"),
        lengthNode = child(item, "length");
      if (startNode?.type !== "number" || lengthNode?.type !== "number")
        return false;
      const startText = text.slice(
        startNode.offset,
        startNode.offset + startNode.length,
      );
      const lengthText = text.slice(
        lengthNode.offset,
        lengthNode.offset + lengthNode.length,
      );
      if (
        !/^(?:0|[1-9][0-9]*)$/.test(startText) ||
        !/^(?:0|[1-9][0-9]*)$/.test(lengthText)
      )
        return false;
      const start = Number(startText);
      const length = Number(lengthText);
      if (
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(length) ||
        start < 0 ||
        length <= 0 ||
        !Number.isSafeInteger(start + length) ||
        (byteLength !== null && start + length > byteLength)
      )
        return false;
      output.push({
        source_unit: source,
        library_name: library,
        immutable_id: immutable,
        start,
        length,
        source_range: range(item),
      });
    }
    return true;
  }
  for (const property of properties(node)) {
    const key = property.children?.[0]?.value as string;
    const value = property.children?.[1];
    if (value === undefined)
      return failure("format", "Malformed reference property");
    if (kind === "immutable") {
      if (!spans(value, null, null, key))
        return failure(
          "format",
          "Malformed or out-of-range immutable reference span",
        );
    } else {
      if (value.type !== "object")
        return failure("format", "Link source references must be objects");
      for (const library of properties(value)) {
        const array = library.children?.[1];
        if (
          array === undefined ||
          !spans(array, key, library.children?.[0]?.value as string, null)
        )
          return failure(
            "format",
            "Malformed or out-of-range link reference span",
          );
      }
    }
  }
  return ok(output);
}

/** Select one recorded compiler object without executing solc or resolving imports. */
export function selectSolcArtifact(
  bytes: Uint8Array,
  selection: CompilerSelection,
): Result<
  {
    artifact: SolcArtifact;
    bytes: Uint8Array | null;
    byteLength: number | null;
  },
  SolcArtifactSelectionError
> {
  if (bytes.byteLength > SOLC_JSON_LIMITS.inputBytes)
    return failure("resource", "Compiler JSON exceeds the 4 MiB input limit");
  const selected = compilerSelectionSchema.safeParse(selection);
  if (!selected.success)
    return failure(
      "selection",
      "Compiler selection requires exact source unit, contract and bytecode kind",
    );
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
  } catch {
    return failure("format", "Compiler JSON is not valid UTF-8");
  }
  const parsed = strictTree(text);
  if (!parsed.ok) return parsed;
  if (parsed.value.type !== "object")
    return failure("format", "Compiler JSON must be an object");
  const diagnostics = compilerDiagnostics(parsed.value, text);
  if (!diagnostics.ok) return diagnostics;
  const result = selectFromTree(
    parsed.value,
    text,
    selected.data,
    diagnostics.value,
  );
  return !result.ok && diagnostics.value !== null
    ? err({ ...result.error, compiler_diagnostics: diagnostics.value })
    : result;
}

function compilerDiagnostics(
  tree: Node,
  text: string,
): Result<SolcArtifact["diagnostics"], SolcArtifactSelectionError> {
  const errors = child(tree, "errors");
  if (errors !== undefined && errors.type !== "array")
    return failure("format", "Compiler diagnostics must be an array");
  const diagnostics =
    errors === undefined
      ? null
      : properties(errors).map((node, index) => ({
          raw_json: text.slice(node.offset, node.offset + node.length),
          source_range: range(node),
          json_pointer: `/errors/${index}`,
          severity:
            child(node, "severity")?.type === "string"
              ? (child(node, "severity")?.value as string)
              : null,
        }));
  return ok(diagnostics);
}

function selectFromTree(
  tree: Node,
  text: string,
  selection: CompilerSelection,
  diagnostics: SolcArtifact["diagnostics"],
): Result<
  {
    artifact: SolcArtifact;
    bytes: Uint8Array | null;
    byteLength: number | null;
  },
  SolcArtifactSelectionError
> {
  const contractResult = selectedContract(tree, selection);
  if (!contractResult.ok) return contractResult;
  const contract = contractResult.value;
  const bytecodeKey =
    selection.bytecode_kind === "creation" ? "bytecode" : "deployedBytecode";
  const evm = child(contract, "evm");
  if (evm !== undefined && evm.type !== "object")
    return failure("format", "Selected contract evm output must be an object");
  const bytecode = child(evm, bytecodeKey);
  if (bytecode !== undefined && bytecode.type !== "object")
    return failure("format", "Selected compiler bytecode must be an object");
  const objectNode = child(bytecode, "object");
  if (objectNode !== undefined && objectNode.type !== "string")
    return failure("format", "Compiler bytecode object must be a string");
  const object = objectNode === undefined ? null : (objectNode.value as string);
  const decoded = object === null ? null : inspectSolcBytecodeObject(object);
  if (decoded !== null && !decoded.ok) return failure("format", decoded.error);
  const byteLength = decoded?.ok ? decoded.value.byteLength : null;
  const placeholders = decoded?.ok ? decoded.value.placeholders : [];
  const links = references(
    child(bytecode, "linkReferences"),
    "link",
    text,
    byteLength,
  );
  if (!links.ok) return links;
  const immutables = references(
    child(bytecode, "immutableReferences"),
    "immutable",
    text,
    byteLength,
  );
  if (!immutables.ok) return immutables;
  const artifact: SolcArtifact = {
    selection,
    json_pointer: `/contracts/${pointer(selection.source_unit)}/${pointer(selection.contract_name)}/evm/${bytecodeKey}`,
    contract_range: range(contract),
    bytecode_range: nullableRange(bytecode),
    object_range: nullableRange(objectNode),
    object,
    status:
      object === null
        ? "absent"
        : placeholders.length > 0
          ? "unlinked"
          : "concrete",
    reference_bounds: object === null ? "unavailable" : "verified",
    link_references: links.value,
    immutable_references: immutables.value,
    placeholders,
    diagnostics,
    metadata: compilerMetadata(child(contract, "metadata"), text),
  };
  return ok({
    artifact,
    byteLength,
    bytes:
      artifact.status === "concrete" && object !== null
        ? Uint8Array.from(Buffer.from(object, "hex"))
        : null,
  });
}

function compilerMetadata(
  metadataNode: Node | undefined,
  text: string,
): SolcArtifact["metadata"] {
  const raw =
    metadataNode?.type === "string"
      ? (metadataNode.value as string)
      : metadataNode === undefined
        ? null
        : text.slice(
            metadataNode.offset,
            metadataNode.offset + metadataNode.length,
          );
  return {
    raw,
    source_range: nullableRange(metadataNode),
    ...(metadataNode?.type === "string" || metadataNode === undefined
      ? compilerMetadataFacts(raw)
      : {
          parse_status: "malformed" as const,
          compiler_version: null,
          settings_json: null,
        }),
  };
}

function selectedContract(
  tree: Node,
  selection: CompilerSelection,
): Result<Node, SolcArtifactSelectionError> {
  const contracts = child(tree, "contracts");
  if (contracts !== undefined && contracts.type !== "object")
    return failure("format", "Compiler contracts output must be an object");
  const source = child(contracts, selection.source_unit);
  if (source !== undefined && source.type !== "object")
    return failure("format", "Selected source unit output must be an object");
  const contract = child(source, selection.contract_name);
  if (contract !== undefined && contract.type !== "object")
    return failure("format", "Selected contract output must be an object");
  if (contract?.type !== "object")
    return failure(
      "selection",
      "Exact compiler source unit and contract were not found",
    );
  return ok(contract);
}
