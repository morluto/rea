import { createHash } from "node:crypto";

import type { BrowserScenario } from "../domain/browserScenario.js";
import type {
  BrowserScenarioUrl,
  BrowserScenarioValue,
} from "../domain/browserScenarioValues.js";
import {
  sanitizeBrowserUrl,
  type SanitizedBrowserUrl,
} from "../domain/browserObservation.js";
import type { BrowserStorageValueFingerprint } from "../domain/browserScenarioCaptureValues.js";

const REDACTION_PREFIX = "[REDACTED:";

const encodedSecretValues = (secret: string): ReadonlySet<string> =>
  new Set([
    encodeURIComponent(secret),
    new URLSearchParams([["value", secret]]).toString().slice("value=".length),
  ]);

type SecretSpellings = "url" | "text";
interface SecretPattern {
  readonly text: string;
  readonly searchText: string;
  readonly percentInsensitive: boolean;
}
interface SecretReplacement extends SecretPattern {
  readonly id: string;
}
interface SecretNeedle {
  readonly id: string;
  readonly needle: Buffer;
  readonly percentInsensitive: boolean;
  readonly marker: Buffer;
}

const normalizePercentEscapes = (value: string): string => {
  if (!value.includes("%")) return value;
  return value.replace(/%[0-9a-f]{2}/giu, (escape) => escape.toLowerCase());
};

const secretPatterns = (
  secret: string,
  spellings: SecretSpellings,
): readonly SecretPattern[] => {
  if (secret === "") return [];
  const patterns: SecretPattern[] = [
    { text: secret, searchText: secret, percentInsensitive: false },
    ...[...encodedSecretValues(secret)].map((text) => ({
      text,
      searchText: normalizePercentEscapes(text),
      percentInsensitive: true,
    })),
  ];
  if (spellings === "text")
    patterns.push({
      text: JSON.stringify(secret).slice(1, -1),
      searchText: JSON.stringify(secret).slice(1, -1),
      percentInsensitive: false,
    });
  const seen = new Set<string>();
  return patterns.filter(({ text, percentInsensitive }) => {
    if (text === "") return false;
    const key = `${percentInsensitive ? "percent" : "literal"}:${text}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

const declaredPatterns = (
  values: ReadonlyMap<string, string>,
  spellings: SecretSpellings,
): readonly SecretPattern[] => {
  const seen = new Set<string>();
  return [...values.values()]
    .flatMap((secret) => secretPatterns(secret, spellings))
    .filter(({ text, percentInsensitive }) => {
      const key = `${percentInsensitive ? "percent" : "literal"}:${text}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
};

const secretReplacements = (
  values: ReadonlyMap<string, string>,
  spellings: SecretSpellings,
): readonly SecretReplacement[] =>
  [...values]
    .flatMap(([id, secret]) =>
      secretPatterns(secret, spellings).map((pattern) => ({ id, ...pattern })),
    )
    .sort(
      (left, right) =>
        right.text.length - left.text.length ||
        (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
    );

const normalizePercentEscapesBytes = (value: Buffer): Buffer => {
  if (value.indexOf(37) < 0) return value;
  const normalized = Buffer.from(value);
  for (let index = 0; index + 2 < normalized.length; index += 1)
    if (
      normalized[index] === 37 &&
      isHexByte(normalized[index + 1]) &&
      isHexByte(normalized[index + 2])
    ) {
      normalized[index + 1] = lowercaseHexByte(normalized[index + 1]!);
      normalized[index + 2] = lowercaseHexByte(normalized[index + 2]!);
      index += 2;
    }
  return normalized;
};

const isHexByte = (value: number | undefined): boolean =>
  value !== undefined &&
  ((value >= 48 && value <= 57) ||
    (value >= 65 && value <= 70) ||
    (value >= 97 && value <= 102));

const lowercaseHexByte = (value: number): number =>
  value >= 65 && value <= 70 ? value + 32 : value;

const patternMatches = (
  value: string,
  normalizedValue: string,
  pattern: SecretPattern,
): boolean =>
  (pattern.percentInsensitive ? normalizedValue : value).includes(
    pattern.searchText,
  );

const containsSecretPattern = (
  value: string,
  normalizedValue: string,
  patterns: readonly SecretPattern[],
): boolean => {
  if (patterns.length === 0) return false;
  return patterns.some((pattern) =>
    patternMatches(value, normalizedValue, pattern),
  );
};

const containsSecretBytePattern = (
  value: Buffer,
  normalizedValue: Buffer,
  needles: readonly SecretNeedle[],
): boolean =>
  needles.some((needle) =>
    (needle.percentInsensitive ? normalizedValue : value).includes(
      needle.needle,
    ),
  );

/** Pick a marker that does not itself contain a declared secret spelling. */
const redactionMarker = (
  id: string,
  patterns: readonly SecretPattern[],
): string => {
  const candidates = [`${REDACTION_PREFIX}${id}]`, "[REDACTED]", "…", ""];
  return (
    candidates.find((candidate) =>
      patterns.every(
        (pattern) =>
          !patternMatches(
            candidate,
            normalizePercentEscapes(candidate),
            pattern,
          ),
      ),
    ) ?? ""
  );
};

const replaceSecretLiterals = (
  value: string,
  replacements: readonly SecretReplacement[],
  patterns: readonly SecretPattern[],
): string => {
  const normalizedValue = replacements.some(
    ({ percentInsensitive }) => percentInsensitive,
  )
    ? normalizePercentEscapes(value)
    : value;
  const parts: string[] = [];
  let offset = 0;
  while (offset < value.length) {
    let next:
      | ((typeof replacements)[number] & { readonly index: number })
      | undefined;
    for (const replacement of replacements) {
      const search = replacement.searchText;
      const view = replacement.percentInsensitive ? normalizedValue : value;
      const index = view.indexOf(search, offset);
      if (
        index >= 0 &&
        (next === undefined ||
          index < next.index ||
          (index === next.index && replacement.text.length > next.text.length))
      )
        next = { ...replacement, index };
    }
    if (next === undefined) break;
    const marker = redactionMarker(next.id, patterns);
    parts.push(value.slice(offset, next.index), marker);
    offset = next.index + next.text.length;
  }
  if (parts.length === 0) return value;
  parts.push(value.slice(offset));
  return parts.join("");
};

const secretNeedles = (
  replacements: readonly SecretReplacement[],
  patterns: readonly SecretPattern[],
): SecretNeedle[] =>
  replacements.map((pattern) => ({
    id: pattern.id,
    needle: Buffer.from(pattern.searchText),
    percentInsensitive: pattern.percentInsensitive,
    marker: Buffer.from(redactionMarker(pattern.id, patterns)),
  }));

/** Resolved secret values kept only for one in-memory scenario session. */
export class BrowserScenarioSecrets {
  private readonly urlPatterns: readonly SecretPattern[];
  private readonly textPatterns: readonly SecretPattern[];
  private readonly urlReplacements: readonly SecretReplacement[];
  private readonly textReplacements: readonly SecretReplacement[];
  private readonly textNeedles: readonly SecretNeedle[];

  private constructor(private readonly values: ReadonlyMap<string, string>) {
    this.urlPatterns = declaredPatterns(values, "url");
    this.textPatterns = declaredPatterns(values, "text");
    this.urlReplacements = secretReplacements(values, "url");
    this.textReplacements = secretReplacements(values, "text");
    this.textNeedles = secretNeedles(this.textReplacements, this.textPatterns);
  }

  static resolve(
    scenario: BrowserScenario,
    environment: Readonly<Record<string, string | undefined>>,
  ): BrowserScenarioSecrets | undefined {
    const values = new Map<string, string>();
    for (const declaration of scenario.secrets) {
      const value = environment[declaration.environment_variable];
      if (
        !Object.hasOwn(environment, declaration.environment_variable) ||
        typeof value !== "string"
      )
        return undefined;
      values.set(declaration.secret_id, value);
    }
    return new BrowserScenarioSecrets(values);
  }

  value(source: BrowserScenarioValue): string {
    if (source.source === "literal") return source.value;
    const value = this.values.get(source.secret_id);
    if (value === undefined)
      throw new Error("Validated browser secret was not resolved");
    return value;
  }

  url(destination: BrowserScenarioUrl): string {
    const url = new URL(destination.url);
    for (const { name, value } of destination.query)
      url.searchParams.append(name, this.value(value));
    return url.href;
  }

  redact(value: string): string {
    const patterns = this.textPatterns;
    if (patterns.length === 0) return value;
    const output = replaceSecretLiterals(
      value,
      this.textReplacements,
      patterns,
    );
    return containsSecretPattern(
      output,
      normalizePercentEscapes(output),
      patterns,
    )
      ? ""
      : output;
  }

  /** Replace declared UTF-8, URI/form, and JSON-escaped secret spellings. */
  redactBytes(value: Buffer): Buffer {
    const patterns = this.textPatterns;
    if (patterns.length === 0) return value;
    const candidates = this.textNeedles;
    const hasPercentPatterns = candidates.some(
      ({ percentInsensitive }) => percentInsensitive,
    );
    const normalizedValue =
      hasPercentPatterns && value.indexOf(37) >= 0
        ? normalizePercentEscapesBytes(value)
        : value;
    const sortedCandidates = candidates
      .map((candidate) => ({
        ...candidate,
        index: (candidate.percentInsensitive ? normalizedValue : value).indexOf(
          candidate.needle,
        ),
      }))
      .sort(
        (left, right) =>
          right.needle.length - left.needle.length ||
          (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
      );
    const parts: Buffer[] = [];
    let offset = 0;
    while (true) {
      let next: (typeof sortedCandidates)[number] | undefined;
      for (const candidate of sortedCandidates) {
        if (candidate.index >= 0 && candidate.index < offset)
          candidate.index = (
            candidate.percentInsensitive ? normalizedValue : value
          ).indexOf(candidate.needle, offset);
        if (
          candidate.index >= 0 &&
          (next === undefined ||
            candidate.index < next.index ||
            (candidate.index === next.index &&
              candidate.needle.length > next.needle.length))
        )
          next = candidate;
      }
      if (next === undefined) break;
      parts.push(value.subarray(offset, next.index), next.marker);
      offset = next.index + next.needle.length;
    }
    if (parts.length === 0) return value;
    parts.push(value.subarray(offset));
    const redacted = Buffer.concat(parts);
    const normalizedRedacted =
      hasPercentPatterns && redacted.indexOf(37) >= 0
        ? normalizePercentEscapesBytes(redacted)
        : redacted;
    return containsSecretBytePattern(redacted, normalizedRedacted, candidates)
      ? Buffer.alloc(0)
      : redacted;
  }

  /** Remove only declared secret values from one URL and report that action. */
  sanitizeUrl(value: string): SanitizedBrowserUrl {
    const patterns = this.urlPatterns;
    if (patterns.length === 0) return sanitizeBrowserUrl(value);
    const output = replaceSecretLiterals(value, this.urlReplacements, patterns);
    if (
      containsSecretPattern(output, normalizePercentEscapes(output), patterns)
    )
      return {
        url: "",
        origin: null,
        query_parameter_names: [],
        redacted: true,
      };
    const sanitized = sanitizeBrowserUrl(output);
    return {
      ...sanitized,
      redacted: sanitized.redacted || output !== value,
    };
  }

  fingerprint(value: string): BrowserStorageValueFingerprint {
    const patterns = this.textPatterns;
    if (
      patterns.length > 0 &&
      containsSecretPattern(value, normalizePercentEscapes(value), patterns)
    )
      return { value_state: "redacted-secret", value_sha256: null };
    return {
      value_state: "hashed",
      value_sha256: createHash("sha256").update(value).digest("hex"),
    };
  }
}
