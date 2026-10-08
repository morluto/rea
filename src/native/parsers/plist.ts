import { z } from "zod";

import { AnalysisOutputError } from "../../domain/analysisErrorCore.js";
import type { JsonValue } from "../../domain/jsonValue.js";
import {
  projectPlistValue,
  type ProjectedPlistValue,
} from "../../domain/apple/plistValue.js";
import { parseXmlPropertyList } from "../../domain/propertyListKeys.js";
import { err, ok, type Result } from "../../domain/result.js";

const plistObject = z.record(z.string(), z.unknown());

/** Stable bundle metadata projected from one plist value. */
export interface PlistBundleMetadata {
  readonly identifier: string | null;
  readonly executable: string | null;
  readonly name: string | null;
  readonly version: string | null;
  readonly short_version: string | null;
}

/** One decoded plist with bundle metadata and decoding limitations. */
export interface ParsedPlist {
  readonly value: unknown;
  readonly bundle: PlistBundleMetadata;
  readonly limitations: readonly string[];
}

/** Digits of a JSON number literal that has no fraction or exponent. */
const INTEGRAL_LITERAL = /^-?\d+$/u;

/**
 * Decode plutil JSON, passing each integral number literal beyond the exact
 * range of a JavaScript number, with its source digits, to `unsafe`.
 */
const decodePlistJson = (
  output: string,
  unsafe: (item: number, digits: string) => unknown,
): unknown => {
  // plutil output can carry a UTF-8 BOM, which JSON.parse rejects outright.
  const text = output.replace(/^\uFEFF/u, "");
  return JSON.parse(
    text,
    (_key: string, item: unknown, context?: { readonly source?: string }) => {
      const source = context?.source;
      return typeof item !== "number" ||
        Number.isSafeInteger(item) ||
        source === undefined ||
        !INTEGRAL_LITERAL.test(source)
        ? item
        : unsafe(item, source);
    },
  );
};

/**
 * Whether plutil JSON holds an integral number beyond the exact range of a
 * JSON number. JSON prints an integral `<real>` and an `<integer>` alike, so
 * such a number's element type must be read from plutil's XML conversion.
 */
export const plistJsonNeedsNumberTypes = (output: string): boolean => {
  let found = false;
  try {
    decodePlistJson(output, (item) => {
      found = true;
      return item;
    });
  } catch {
    // Malformed JSON is reported by `parsePlistJson`.
  }
  return found;
};

/**
 * Parse plutil JSON output and project stable bundle metadata. An integer
 * beyond the exact range of a JSON number keeps its decimal text when
 * `xmlConversion`, plutil's XML form of the same plist, shows that it came
 * from an `<integer>` rather than a `<real>`.
 */
export const parsePlistJson = (
  output: string,
  xmlConversion?: string,
): Result<ParsedPlist, AnalysisOutputError> => {
  const literals =
    xmlConversion === undefined ? undefined : xmlNumberLiterals(xmlConversion);
  let exactIntegerCount = 0;
  let ambiguousNumberCount = 0;
  const classify = (item: number, digits: string): unknown => {
    const exact = BigInt(digits).toString();
    const integer = literals?.integers.get(item)?.has(exact) === true;
    const real = literals?.reals.has(item) === true;
    if (integer && !real) {
      exactIntegerCount += 1;
      return { $plist_type: "integer", decimal: digits };
    }
    // An integral <real> decodes exactly; only its JSON spelling is integral.
    if (real && !integer) return item;
    ambiguousNumberCount += 1;
    return item;
  };
  let value: unknown;
  try {
    value = decodePlistJson(output, classify);
  } catch (cause: unknown) {
    return err(
      new AnalysisOutputError(
        "inspect_plist",
        cause instanceof Error ? cause.message : String(cause),
        { cause },
      ),
    );
  }
  return ok({
    value,
    bundle: projectPlistBundle(value),
    limitations: numberLimitations(exactIntegerCount, ambiguousNumberCount),
  });
};

/**
 * Parse plutil XML output for a plist that JSON cannot express, such as one
 * containing data, dates, or non-finite reals.
 */
export const parsePlistXml = (
  output: string,
): Result<ParsedPlist, AnalysisOutputError> => {
  let projected: ProjectedPlistValue;
  try {
    projected = projectPlistValue(parseXmlPropertyList(output));
  } catch (cause: unknown) {
    return err(
      new AnalysisOutputError(
        "inspect_plist",
        "plutil XML conversion was not a readable plist",
        { cause },
      ),
    );
  }
  // The XML decoder turns <integer> and <real> into numbers before REA sees
  // them, rounding integers beyond the exact range.
  const literals = xmlNumberLiterals(output);
  let exactIntegerCount = 0;
  let ambiguousNumberCount = 0;
  const value = mapJsonNumbers(projected.value, (item) => {
    const decimals = literals.integers.get(item);
    if (decimals === undefined) return item;
    const [decimal] = decimals;
    if (
      decimals.size !== 1 ||
      decimal === undefined ||
      literals.reals.has(item)
    ) {
      ambiguousNumberCount += 1;
      return item;
    }
    exactIntegerCount += 1;
    return { $plist_type: "integer", decimal };
  });
  return ok({
    value,
    bundle: projectPlistBundle(value),
    limitations: [
      'plutil cannot express this plist as JSON, so it was decoded from plutil\'s XML conversion; data and date values are typed objects such as { "$plist_type": "data", "base64": ... }.',
      ...(projected.unknownRealCount === 0
        ? []
        : [
            `${String(projected.unknownRealCount)} non-finite real value(s) are reported as { "$plist_type": "real", "value": null } because the XML decoder does not distinguish NaN from infinity.`,
          ]),
      ...numberLimitations(exactIntegerCount, ambiguousNumberCount),
    ],
  });
};

/** `<integer>` and `<real>` element literals in plutil's XML conversion. */
interface XmlNumberLiterals {
  /** Exact integer literals beyond the safe range, keyed by decoded number. */
  readonly integers: ReadonlyMap<number, ReadonlySet<string>>;
  readonly reals: ReadonlySet<number>;
}

// plutil escapes "<" in keys and strings, so these element literals can be
// read from the XML text.
const xmlNumberLiterals = (xml: string): XmlNumberLiterals => {
  const integers = new Map<number, Set<string>>();
  for (const [, decimal = ""] of xml.matchAll(
    /<integer>\s*([+-]?\d+)\s*<\/integer>/gu,
  )) {
    const rounded = Number(decimal);
    if (Number.isSafeInteger(rounded)) continue;
    integers.set(
      rounded,
      (integers.get(rounded) ?? new Set()).add(BigInt(decimal).toString()),
    );
  }
  const reals = new Set(
    [...xml.matchAll(/<real>([^<]*)<\/real>/gu)].map(([, text = ""]) =>
      Number.parseFloat(text),
    ),
  );
  return { integers, reals };
};

const numberLimitations = (
  exactIntegerCount: number,
  ambiguousNumberCount: number,
): string[] => [
  ...(exactIntegerCount === 0
    ? []
    : [
        `${String(exactIntegerCount)} integer value(s) exceed the exact range of a JSON number and are reported as { "$plist_type": "integer", "decimal": "<exact digits>" }.`,
      ]),
  ...(ambiguousNumberCount === 0
    ? []
    : [
        `${String(ambiguousNumberCount)} number(s) beyond the exact range of a JSON number are reported as decoded because the XML literal they came from, a rounded <integer> or a <real>, cannot be identified.`,
      ]),
];

const mapJsonNumbers = (
  value: JsonValue,
  map: (item: number) => JsonValue,
): JsonValue => {
  if (typeof value === "number") return map(value);
  if (Array.isArray(value))
    return value.map((item) => mapJsonNumbers(item, map));
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        mapJsonNumbers(item, map),
      ]),
    );
  return value;
};

const projectPlistBundle = (value: unknown): PlistBundleMetadata => {
  const object = plistObject.safeParse(value);
  const field = (name: string): string | null => {
    if (!object.success) return null;
    const candidate = object.data[name];
    return typeof candidate === "string" ? candidate : null;
  };
  return {
    identifier: field("CFBundleIdentifier"),
    executable: field("CFBundleExecutable"),
    name: field("CFBundleName"),
    version: field("CFBundleVersion"),
    short_version: field("CFBundleShortVersionString"),
  };
};
