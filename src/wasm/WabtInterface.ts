import { decodeStrictUtf8 } from "../domain/strictUtf8.js";
import { WabtAdmissionError } from "./WabtAdmissionError.js";
import { AnalysisResourceConstraintError } from "../domain/analysisErrorCore.js";
import {
  DEFAULT_WASM_INTERFACE_REPRESENTATION_BYTES,
  wasmInterfaceEntryRepresentationBytes,
} from "../domain/wasm/wasmInterface.js";
import { WasmInterfaceBudget } from "../domain/wasm/wasmInterfaceBudget.js";
import type {
  WasmInterface,
  WasmInterfaceEntry,
  WasmInterfaceSignature,
  WasmInterfaceValueType,
} from "../domain/wasm/wasmInterface.js";
import { watString, watStringEnd } from "./WabtString.js";
import { watCommentEnd } from "./WabtComment.js";

const isWatWhitespace = (text: string, index: number): boolean => {
  const code = text.charCodeAt(index);
  if (code === 0x20 || (code >= 0x09 && code <= 0x0d)) return true;
  return code >= 0x80 && /\s/u.test(text[index] ?? "");
};

const scanCommentEnd = (text: string, index: number): number | undefined => {
  const code = text.charCodeAt(index);
  if (code !== 0x3b && !(code === 0x28 && text.charCodeAt(index + 1) === 0x3b))
    return undefined;
  return watCommentEnd(text, index);
};

const scanNestedFormEnd = (form: string, start: number): number => {
  let depth = 1;
  let i = start + 1;
  while (i < form.length && depth > 0) {
    const commentEnd = scanCommentEnd(form, i);
    if (commentEnd !== undefined) {
      i = commentEnd;
      continue;
    }
    const code = form.charCodeAt(i);
    if (code === 0x22) i = watStringEnd(form, i + 1);
    else {
      if (code === 0x28) depth++;
      else if (code === 0x29) depth--;
      i++;
    }
  }
  return i;
};

const scanAtomEnd = (form: string, start: number): number => {
  let i = start;
  while (i < form.length) {
    const code = form.charCodeAt(i);
    if (code === 0x28 || code === 0x29 || isWatWhitespace(form, i)) break;
    i++;
  }
  return i;
};

/** Split direct WAT children only; function instruction bodies are never materialized. */
const splitParts = (form: string, maximumBytes?: number): readonly string[] => {
  const limit = maximumBytes ?? DEFAULT_WASM_INTERFACE_REPRESENTATION_BYTES;
  if (!Number.isSafeInteger(limit) || limit < 0)
    new WasmInterfaceBudget(maximumBytes);
  let remaining = limit;
  const items: string[] = [];
  let i = 1;
  const last = form.length - 1;
  while (i < last) {
    if (isWatWhitespace(form, i)) {
      i++;
      continue;
    }
    const commentEnd = scanCommentEnd(form, i);
    if (commentEnd !== undefined) {
      i = commentEnd;
      continue;
    }
    const start = i;
    const code = form.charCodeAt(i);
    if (code === 0x22) {
      i = watStringEnd(form, i + 1);
    } else if (code === 0x28) {
      i = scanNestedFormEnd(form, i);
    } else {
      i = scanAtomEnd(form, i);
      if (i > start && items[0] === "func" && items.length > 1 && code !== 0x24)
        break;
    }
    if (i <= start) throw new WabtAdmissionError("malformed_form");
    remaining -= 64 + (i - start) * 2;
    if (remaining < 0) new WasmInterfaceBudget(maximumBytes).reserve(limit + 1);
    items.push(form.slice(start, i));
  }
  return items;
};
const name = (text: string | undefined): string => {
  if (text?.startsWith('"') !== true)
    throw new WabtAdmissionError("name_missing");
  return decodeStrictUtf8(watString(text, 1).bytes, "preserve");
};
const integer = (text: string): string | null => {
  if (!/^(?:\d+|0x[\da-f]+)$/iu.test(text)) return null;
  return BigInt(text).toString();
};

const DEFINITION_KINDS = new Set(["func", "table", "memory", "global", "tag"]);

const toDefinitionKind = (rawKind: string): WasmInterfaceEntry["kind"] =>
  DEFINITION_KINDS.has(rawKind)
    ? (rawKind as WasmInterfaceEntry["kind"])
    : "unknown";

const admittedValues = new Set([
  "i32",
  "i64",
  "f32",
  "f64",
  "v128",
  "funcref",
  "externref",
]);
const isValueType = (type: string): type is WasmInterfaceValueType =>
  admittedValues.has(type);

const collectCategoryValues = (
  bodyParts: readonly string[],
  category: string,
  getGroupParts: (index: number) => readonly string[],
): WasmInterfaceValueType[] | null => {
  const values: WasmInterfaceValueType[] = [];
  for (let i = 1; i < bodyParts.length; i++) {
    if (bodyParts[i]!.charCodeAt(0) !== 0x28) continue;
    const group = getGroupParts(i);
    if (group[0] !== category) continue;
    for (let j = 1; j < group.length; j++) {
      const type = group[j]!;
      if (type.charCodeAt(0) === 0x24) continue;
      if (!isValueType(type)) return null;
      values.push(type);
    }
  }
  return values;
};

const parseFunctionType = (
  bodyParts: readonly string[],
  kind: "func" | "tag",
  splitGroup: (group: string) => readonly string[],
  initialChildren?: readonly (readonly string[] | undefined)[],
): WasmInterfaceSignature | null => {
  const children: (readonly string[] | undefined)[] = initialChildren
    ? [...initialChildren]
    : Array(bodyParts.length);
  const getGroupParts = (index: number): readonly string[] => {
    let group = children[index];
    if (group === undefined) {
      group = splitGroup(bodyParts[index]!);
      children[index] = group;
    }
    return group;
  };
  const params = collectCategoryValues(bodyParts, "param", getGroupParts);
  const results = collectCategoryValues(bodyParts, "result", getGroupParts);
  return params === null || results === null ? null : { kind, params, results };
};

const collectSignatureTokens = (
  kind: "memory" | "table",
  parts: readonly string[],
  splitGroup: (group: string) => readonly string[],
): { readonly pageSize: string; readonly tokens: string[] } | null => {
  let pageSize = "65536";
  const tokens: string[] = [];
  for (let i = 1; i < parts.length; i++) {
    const token = parts[i]!;
    const first = token.charCodeAt(0);
    if (first === 0x28) {
      const declaration = splitGroup(token);
      if (
        kind !== "memory" ||
        declaration[0] !== "pagesize" ||
        declaration.length !== 2
      )
        return null;
      const parsedPageSize = integer(declaration[1] ?? "");
      if (parsedPageSize === null) return null;
      pageSize = parsedPageSize;
    } else if (first !== 0x24) {
      tokens.push(token);
    }
  }
  return { pageSize, tokens };
};

const parseMemoryOrTableSignature = (
  kind: "memory" | "table",
  parts: readonly string[],
  splitGroup: (group: string) => readonly string[],
): WasmInterfaceSignature | null => {
  const collected = collectSignatureTokens(kind, parts, splitGroup);
  if (collected === null) return null;
  const { pageSize, tokens } = collected;
  let cursor = 0;
  const firstToken = tokens[cursor];
  const address_type = firstToken === "i64" ? "i64" : "i32";
  if (firstToken === "i64" || firstToken === "i32") cursor++;
  const minimum = integer(tokens[cursor++] ?? "");
  const possibleMaximum =
    cursor < tokens.length ? integer(tokens[cursor]!) : null;
  if (possibleMaximum !== null) cursor++;
  const shared = tokens[cursor] === "shared";
  if (shared) cursor++;
  if (minimum === null) return null;
  if (kind === "memory")
    return cursor === tokens.length
      ? {
          kind,
          page_size: pageSize,
          address_type,
          minimum,
          maximum: possibleMaximum,
          shared,
        }
      : null;
  const element = tokens[cursor++];
  return cursor === tokens.length &&
    (element === "funcref" || element === "externref")
    ? {
        kind,
        address_type,
        minimum,
        maximum: possibleMaximum,
        shared,
        element,
      }
    : null;
};

const parseGlobalSignature = (
  parts: readonly string[],
  splitGroup: (group: string) => readonly string[],
): WasmInterfaceSignature | null => {
  const declaration = parts[1]?.startsWith("$") === true ? parts[2] : parts[1];
  const group =
    declaration?.startsWith("(") === true ? splitGroup(declaration) : undefined;
  const mutable = group?.[0] === "mut";
  const value_type = mutable ? group?.[1] : declaration;
  return value_type !== undefined && isValueType(value_type)
    ? { kind: "global", value_type, mutable }
    : null;
};

const parseFormSignature = (
  ctx: DecoderContext,
  parts: readonly string[],
): WasmInterfaceSignature | null => {
  const kind = parts[0];
  if (kind === "func" || kind === "tag") {
    // Interpret group heads through the same comment/whitespace framing as
    // their values; raw prefixes can mistake an explicit type for no type.
    const childGroups: (readonly string[] | undefined)[] = Array(parts.length);
    let typeUse: readonly string[] | undefined;
    for (let i = 1; i < parts.length; i++) {
      const token = parts[i]!;
      if (token.charCodeAt(0) !== 0x28) continue;
      const group = ctx.splitGroup(token);
      childGroups[i] = group;
      if (group[0] === "type") {
        typeUse = group;
        break;
      }
    }
    if (typeUse === undefined)
      return parseFunctionType(parts, kind, ctx.splitGroup, childGroups);
    const reference = typeUse[1];
    const index =
      reference === undefined
        ? undefined
        : reference.startsWith("$")
          ? ctx.typeNames.get(reference)
          : Number(reference);
    const type =
      index == null || ctx.typeSpaceUnknown ? undefined : ctx.types[index];
    return type?.kind === "func" ? { ...type, kind } : null;
  }
  if (kind === "memory" || kind === "table")
    return parseMemoryOrTableSignature(kind, parts, ctx.splitGroup);
  if (kind === "global") return parseGlobalSignature(parts, ctx.splitGroup);
  return null;
};

interface DecoderContext {
  readonly forms: readonly string[];
  readonly result: WasmInterface;
  readonly budget: WasmInterfaceBudget;
  readonly splitGroup: (form: string) => readonly string[];
  readonly getFormParts: (index: number) => readonly string[];
  readonly types: (WasmInterfaceSignature | null)[];
  readonly typeNames: Map<string, number | null>;
  readonly definitionNames: Map<string, Map<string, number | null>>;
  readonly definitions: Map<
    string,
    { signature: WasmInterfaceSignature | null }[]
  >;
  readonly ambiguousSpaces: Set<string>;
  readonly typeSpaceUnknown: boolean;
}

const indexLabel = (
  ctx: DecoderContext,
  label: string,
  space: string,
  index: number,
): void => {
  let labels: Map<string, number | null>;
  if (space === "type") {
    labels = ctx.typeNames;
  } else {
    let existing = ctx.definitionNames.get(space);
    if (existing === undefined) {
      existing = new Map<string, number | null>();
      ctx.definitionNames.set(space, existing);
    }
    labels = existing;
  }
  if (!labels.has(label)) {
    labels.set(label, index);
    return;
  }
  if (!ctx.ambiguousSpaces.has(space)) {
    ctx.ambiguousSpaces.add(space);
    ctx.result.issues.push(
      `Ambiguous WABT identifiers in the ${space} index space; named references have unknown identity`,
    );
  }
  labels.set(label, null);
};

const addDefinition = (
  ctx: DecoderContext,
  p: readonly string[],
): {
  index: number;
  kind: WasmInterfaceEntry["kind"];
  signature: WasmInterfaceSignature | null;
} => {
  const kind = toDefinitionKind(p[0] ?? "unknown");
  let space = ctx.definitions.get(kind);
  if (space === undefined) {
    space = [];
    ctx.definitions.set(kind, space);
  }
  const item = {
    signature: parseFormSignature(ctx, p),
  };
  const label = p[1]?.startsWith("$") === true ? p[1] : undefined;
  ctx.budget.reserve(256);
  const index = space.length;
  space.push(item);
  if (label !== undefined) indexLabel(ctx, label, kind, index);
  return { index, kind, signature: item.signature };
};

const appendImportEntry = (ctx: DecoderContext, formIndex: number): void => {
  const p = ctx.getFormParts(formIndex);
  const body = p[3];
  if (body === undefined) throw new WabtAdmissionError("incomplete_import");
  const observed = addDefinition(ctx, ctx.splitGroup(body));
  const entry: WasmInterfaceEntry = {
    direction: "import",
    module: name(p[1]),
    name: name(p[2]),
    ...observed,
    wat_form: ctx.forms[formIndex]!,
    issue:
      observed.signature === null
        ? "Import type is outside admitted core signature semantics"
        : null,
  };
  ctx.budget.reserve(wasmInterfaceEntryRepresentationBytes(entry));
  ctx.result.entries.push(entry);
};

const appendExportEntry = (ctx: DecoderContext, formIndex: number): void => {
  const p = ctx.getFormParts(formIndex);
  const body = p[2];
  if (body === undefined) throw new WabtAdmissionError("incomplete_export");
  const descriptor = ctx.splitGroup(body);
  const kind = toDefinitionKind(descriptor[0] ?? "unknown");
  const reference = descriptor[1];
  const space = ctx.definitions.get(kind);
  const index =
    reference === undefined
      ? -1
      : reference.startsWith("$")
        ? (ctx.definitionNames.get(kind)?.get(reference) ?? -1)
        : Number(reference);
  const observed =
    space !== undefined && Number.isSafeInteger(index) && index >= 0
      ? space[index]
      : undefined;
  const entry: WasmInterfaceEntry = {
    direction: "export",
    module: null,
    name: name(p[1]),
    kind,
    index: observed === undefined ? null : index,
    signature: observed?.signature ?? null,
    wat_form: ctx.forms[formIndex]!,
    issue:
      observed?.signature == null
        ? "Export type/index is outside admitted core signature semantics"
        : null,
  };
  ctx.budget.reserve(wasmInterfaceEntryRepresentationBytes(entry));
  ctx.result.entries.push(entry);
};

/** Resolve index spaces at the producer, not from retained raw WAT in consumers. */
const decodeWabtInterface = (
  forms: readonly string[],
  result: WasmInterface,
  maximumBytes: number | undefined,
): WasmInterface => {
  const formParts: (readonly string[] | undefined)[] = Array(forms.length);
  const shortGroupCache = new Map<string, readonly string[]>();
  const splitGroup = (form: string): readonly string[] => {
    if (form.length > 256) return splitParts(form, maximumBytes);
    let cached = shortGroupCache.get(form);
    if (cached === undefined) {
      cached = splitParts(form, maximumBytes);
      if (shortGroupCache.size < 4096) shortGroupCache.set(form, cached);
    }
    return cached;
  };
  const getFormParts = (index: number): readonly string[] => {
    let parsed = formParts[index];
    if (parsed === undefined) {
      parsed = splitParts(forms[index]!, maximumBytes);
      formParts[index] = parsed;
    }
    return parsed;
  };
  let typeSpaceUnknown = false;
  for (let i = 0; i < forms.length; i++) {
    if (getFormParts(i)[0] === "rec") {
      typeSpaceUnknown = true;
      break;
    }
  }
  const ctx: DecoderContext = {
    forms,
    result,
    budget: new WasmInterfaceBudget(maximumBytes),
    splitGroup,
    getFormParts,
    types: [],
    typeNames: new Map(),
    definitionNames: new Map(),
    definitions: new Map(),
    ambiguousSpaces: new Set(),
    typeSpaceUnknown,
  };
  const importIndices: number[] = [];
  const definitionIndices: number[] = [];
  const exportIndices: number[] = [];
  for (let i = 0; i < forms.length; i++) {
    const p = getFormParts(i);
    const head = p[0];
    if (head === "import") importIndices.push(i);
    else if (head === "export") exportIndices.push(i);
    else if (head !== undefined && DEFINITION_KINDS.has(head))
      definitionIndices.push(i);
    else if (head === "type") {
      if (p[1]?.startsWith("$") === true)
        indexLabel(ctx, p[1], "type", ctx.types.length);
      const body = p.find((item) => item.startsWith("("));
      ctx.budget.reserve(256 + (body?.length ?? 0) * 6);
      if (body === undefined || typeSpaceUnknown) {
        if (body !== undefined) splitGroup(body);
        ctx.types.push(null);
      } else {
        const bodyParts = splitGroup(body);
        ctx.types.push(
          bodyParts[0] === "func"
            ? parseFunctionType(bodyParts, "func", splitGroup)
            : null,
        );
      }
    }
  }
  for (const i of importIndices) appendImportEntry(ctx, i);
  for (const i of definitionIndices) addDefinition(ctx, getFormParts(i));
  for (const i of exportIndices) appendExportEntry(ctx, i);
  // Unsupported signatures leave inventory completeness intact. A missing
  // signature is unknown per entry, not proof that a name is absent.
  return result;
};

/** New typed coverage may be incomplete without discarding existing decoded WAT Evidence. */
export const parseWabtInterface = (
  forms: readonly string[],
  maximumBytes?: number,
): WasmInterface => {
  const result: WasmInterface = { state: "complete", entries: [], issues: [] };
  try {
    return decodeWabtInterface(forms, result, maximumBytes);
  } catch (cause: unknown) {
    if (!(cause instanceof AnalysisResourceConstraintError)) throw cause;
    result.state = "partial";
    result.issues.push(cause.message);
    if (cause.remediationAction !== undefined)
      result.issues.push(cause.remediationAction);
    return result;
  }
};
