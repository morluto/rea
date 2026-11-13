import {
  Document,
  isAlias,
  isMap,
  isScalar,
  isSeq,
  parseDocument,
  type Tags,
  type ScalarTag,
} from "yaml";

import { ConfigurationError } from "../domain/configurationErrors.js";
import {
  copyYamlAliasSource,
  preserveYamlAliasValues,
} from "./YamlConfigurationAliases.js";
import {
  retainYamlConfigurationSource,
  retainYamlScalarSource,
} from "./YamlConfigurationSource.js";

// Goose 1.59.0 loads Mapping/Value through serde_yaml 0.9.34. Its
// scalar resolver differs from the YAML core schema (notably 0123 and 0b11).
// https://github.com/dtolnay/serde-yaml/blob/2009506d33767dfc88e979d6bc0d53d09f941c94/src/de.rs#L858-L1150
const nativeIntegerSyntax =
  /^[+-]?(?:0|[1-9][0-9]*|0b[01]+|0o[0-7]+|0x[0-9a-fA-F]+)$/;
const leadingZeroDigits = /^[+-]?0[0-9]+$/;
const finiteFloatSyntax =
  /^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/;
const nativeFloatSyntax =
  /^(?![+-]?0[0-9]+$)(?:[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?|[+-]?\.(?:inf|Inf|INF)|\.(?:nan|NaN|NAN))$/;
const minimumI64 = -(1n << 63n);
const maximumU64 = (1n << 64n) - 1n;
const minimumI128 = -(1n << 127n);
const maximumU128 = (1n << 128n) - 1n;

/** Undefined means visit_int falls through; Value does not accept i128/u128. */
const nativeGooseInteger = (source: string): bigint | undefined => {
  if (!nativeIntegerSyntax.test(source)) return undefined;
  const negative = source.startsWith("-");
  const unsigned = source.replace(/^[+-]/, "");
  const prefix = /^0[box]/.exec(unsigned)?.[0] ?? "";
  const radix =
    prefix === "0b" ? 2 : prefix === "0o" ? 8 : prefix === "0x" ? 16 : 10;
  const digits = unsigned.slice(prefix.length).replace(/^0+/, "") || "0";
  const maximumMagnitude = negative ? -minimumI128 : maximumU128;
  // Rust's bounded integer readers fall through before a wider allocation.
  if (digits.length > maximumMagnitude.toString(radix).length) return undefined;
  const magnitude = BigInt(`${prefix}${digits}`);
  const value = negative ? -magnitude : magnitude;
  if (value < minimumI128 || value > maximumU128) return undefined;
  if (value < minimumI64 || value > maximumU64)
    throw new TypeError(
      "Goose serde_yaml Value cannot represent an i128/u128 integer",
    );
  return value;
};

const nativeGooseFloat = (source: string): number | undefined => {
  if (/^[+]?\.(?:inf|Inf|INF)$/.test(source)) return Infinity;
  if (/^-\.(?:inf|Inf|INF)$/.test(source)) return -Infinity;
  if (/^\.(?:nan|NaN|NAN)$/.test(source)) return NaN;
  if (!finiteFloatSyntax.test(source)) return undefined;
  const value = Number(source);
  return Number.isFinite(value) ? value : undefined;
};

const implicitGooseNumber = (source: string): bigint | number | string => {
  const integer = nativeGooseInteger(source);
  if (integer !== undefined) return integer;
  if (leadingZeroDigits.test(source)) return source;
  return nativeGooseFloat(source) ?? source;
};

const gooseScalarTags = (tags: Tags): Tags => {
  const scalar = (name: string): ScalarTag => {
    const tag = tags.find(
      (candidate): candidate is ScalarTag =>
        typeof candidate !== "string" &&
        candidate.collection === undefined &&
        candidate.tag === `tag:yaml.org,2002:${name}` &&
        candidate.format === undefined,
    );
    if (tag === undefined)
      throw new Error(`Missing YAML core ${name} scalar tag`);
    return tag;
  };
  const integer = scalar("int");
  const float = scalar("float");
  const explicit = (
    tag: ScalarTag,
    resolve: (source: string) => unknown,
  ): ScalarTag => {
    const { test: _test, ...rest } = tag;
    return { ...rest, default: false, resolve };
  };
  return [
    ...tags.filter(
      (tag) =>
        typeof tag === "string" ||
        (tag.tag !== integer.tag && tag.tag !== float.tag),
    ),
    retainYamlScalarSource({
      ...integer,
      test: nativeIntegerSyntax,
      resolve: implicitGooseNumber,
    }),
    retainYamlScalarSource({
      ...float,
      test: nativeFloatSyntax,
      resolve: implicitGooseNumber,
    }),
    explicit(integer, (source) => {
      const value = nativeGooseInteger(source);
      if (value === undefined)
        throw new TypeError("Invalid Goose integer scalar");
      return value;
    }),
    explicit(float, (source) => {
      const value = nativeGooseFloat(source);
      if (value === undefined)
        throw new TypeError("Invalid Goose float scalar");
      return value;
    }),
    explicit(scalar("bool"), (source) => {
      if (/^(?:true|True|TRUE)$/.test(source)) return true;
      if (/^(?:false|False|FALSE)$/.test(source)) return false;
      throw new TypeError("Invalid Goose boolean scalar");
    }),
    explicit(scalar("null"), (source) => {
      if (/^(?:null|Null|NULL|~)$/.test(source)) return null;
      throw new TypeError("Invalid Goose null scalar");
    }),
  ];
};

const gooseYamlOptions = {
  version: "1.2",
  schema: "core",
  intAsBigInt: true,
  logLevel: "error",
  customTags: gooseScalarTags,
} as const;

/** A duplicate YAML member cannot establish one selected configuration value. */
class GooseConfigurationYamlError extends ConfigurationError {
  readonly kind = "shadowed_member";
  constructor(
    readonly path: readonly string[],
    cause: unknown,
  ) {
    super(
      `Goose YAML contains a duplicate mapping member at ${path.join(".") || "the document root"}`,
      { cause },
    );
  }
}

const emptyRoot = (root: Document["contents"]): boolean =>
  root === null ||
  (isScalar(root) &&
    root.value === null &&
    root.source === "" &&
    root.tag === undefined &&
    root.anchor === undefined);

/** Recover a diagnostic key path from the parser-owned duplicate position. */
const duplicatePath = (
  node: unknown,
  offset: number,
  path: readonly string[] = [],
): readonly string[] | undefined => {
  if (isMap(node)) {
    for (const pair of node.items) {
      const key = isScalar(pair.key) ? pair.key : undefined;
      const next = key === undefined ? path : [...path, String(key.value)];
      if (key?.range?.[0] === offset) return next;
      const nested = duplicatePath(pair.value, offset, next);
      if (nested !== undefined) return nested;
    }
  } else if (isSeq(node)) {
    for (const [index, item] of node.items.entries()) {
      const nested = duplicatePath(item, offset, [...path, String(index)]);
      if (nested !== undefined) return nested;
    }
  }
  return undefined;
};

const parseGooseDocument = (text: string): Document => {
  const document = parseDocument(text, gooseYamlOptions);
  const failure = document.errors[0] ?? document.warnings[0];
  if (failure?.code === "DUPLICATE_KEY")
    throw new GooseConfigurationYamlError(
      duplicatePath(document.contents, failure.pos[0]) ?? [],
      failure,
    );
  if (failure !== undefined)
    throw new ConfigurationError("Invalid or unsupported Goose YAML", {
      cause: failure,
    });
  return document;
};

const gooseDocumentValue = (document: Document): unknown => {
  if (emptyRoot(document.contents)) return {};
  try {
    return document.toJS({
      reviver: (_key, value) =>
        typeof value === "bigint" &&
        value >= BigInt(Number.MIN_SAFE_INTEGER) &&
        value <= BigInt(Number.MAX_SAFE_INTEGER)
          ? Number(value)
          : value,
    });
  } catch (cause: unknown) {
    throw new ConfigurationError("Goose YAML values could not be resolved", {
      cause,
    });
  }
};

/** Parse Goose's native scalar facts without replacing exact 64-bit integers. */
export const parseGooseConfigurationYaml = (text: string): unknown =>
  gooseDocumentValue(parseGooseDocument(text));

export const stringifyGooseConfigurationYaml = (
  document: Record<string, unknown>,
): string =>
  new Document(document, gooseYamlOptions).toString({ lineWidth: 0 });

/** Edit one extension member while retaining unrelated YAML nodes and comments. */
export const editGooseConfigurationYaml = (
  text: string,
  path: readonly string[],
  value: unknown,
): string => {
  const document = parseGooseDocument(text);
  // Resolve against the original graph before editing, including the YAML
  // library's native alias-expansion admission.
  gooseDocumentValue(document);
  const root = document.contents;
  if (emptyRoot(root)) {
    const map = document.createNode({});
    if (isScalar(root))
      map.commentBefore = [root.commentBefore, root.comment]
        .filter((comment) => comment !== undefined)
        .join("\n");
    document.contents = map;
  }
  if (!isMap(document.contents))
    throw new ConfigurationError("Goose configuration root must be a mapping");
  for (let length = 1; length < path.length; length++) {
    const parent = path.slice(0, length);
    let previous = document.getIn(parent, true);
    if (isAlias(previous)) {
      previous = copyYamlAliasSource(previous, document);
      document.setIn(parent, previous);
    }
    if (previous === undefined && !document.hasIn(parent)) {
      if (value === undefined) return text;
      document.setIn(parent, document.createNode({}));
    } else if (!isMap(previous))
      throw new ConfigurationError(
        `Goose configuration ${parent.join(".")} must be a mapping`,
      );
  }
  const previous = document.getIn(path, true);
  const parent = document.getIn(path.slice(0, -1), true);
  const removedKey =
    value === undefined && isMap(parent)
      ? parent.items.find(
          (pair) => isScalar(pair.key) && pair.key.value === path.at(-1),
        )?.key
      : undefined;
  const retained = preserveYamlAliasValues(document, [previous, removedKey]);
  if (value === undefined) {
    if (!document.deleteIn(path)) return text;
  } else
    document.setIn(
      path,
      isMap(previous) || isSeq(previous)
        ? retainYamlConfigurationSource(
            previous,
            document.createNode(value),
            retained,
          )
        : value,
    );
  return document.toString({ lineWidth: 0 });
};
