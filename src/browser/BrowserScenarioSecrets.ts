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
import { redactExplicitText } from "../domain/explicitSensitiveValues.js";

const REDACTION_PREFIX = "[REDACTED:";

const encodedSecretValues = (secret: string): ReadonlySet<string> =>
  new Set([
    secret,
    encodeURIComponent(secret),
    new URLSearchParams([["value", secret]]).toString().slice("value=".length),
  ]);

const yamlSecretValue = (secret: string): string =>
  secret.replace(/[\\"\x00-\x1f\x7f-\x9f]/gu, (character) => {
    const json = JSON.stringify(character).slice(1, -1);
    return json.startsWith("\\u") || character.charCodeAt(0) >= 0x7f
      ? `\\x${character.charCodeAt(0).toString(16).padStart(2, "0")}`
      : json;
  });

const accessibilitySecretValues = (secret: string): readonly string[] => {
  if (secret === "") return [];
  const normalized = secret
    .replace(/[\u200b\u00ad]/gu, "")
    .trim()
    .replace(/\s+/gu, " ");
  return [...new Set([secret, normalized])].flatMap((value) => {
    const json = JSON.stringify(value).slice(1, -1);
    return [
      value,
      json,
      value.replaceAll("'", "''"),
      json.replaceAll("'", "''"),
      yamlSecretValue(value),
    ];
  });
};

/** Resolved secret values kept only for one in-memory scenario session. */
export class BrowserScenarioSecrets {
  private constructor(private readonly values: ReadonlyMap<string, string>) {}

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
    let output = value;
    const replacements = [...this.values].sort(
      ([leftId, left], [rightId, right]) =>
        right.length - left.length ||
        (leftId < rightId ? -1 : leftId > rightId ? 1 : 0),
    );
    for (const [id, secret] of replacements)
      if (secret !== "")
        output = output.replaceAll(secret, `${REDACTION_PREFIX}${id}]`);
    return output;
  }

  /** Redact declared values as normalized and quoted by Playwright snapshots. */
  redactAccessibilityText(value: string): string {
    return redactExplicitText(
      value,
      [...this.values.values()].flatMap(accessibilitySecretValues),
    );
  }

  /** Replace declared UTF-8, URI/form, and JSON-escaped secrets without decoding binary data. */
  redactBytes(value: Buffer): Buffer {
    const candidates = [...this.values]
      .flatMap(([id, secret]) => {
        if (secret === "") return [];
        return [
          ...new Set([
            ...encodedSecretValues(secret),
            JSON.stringify(secret).slice(1, -1),
          ]),
        ].map((text) => {
          const needle = Buffer.from(text);
          return {
            id,
            needle,
            marker: Buffer.from(`${REDACTION_PREFIX}${id}]`),
            index: value.indexOf(needle),
          };
        });
      })
      .sort(
        (left, right) =>
          right.needle.length - left.needle.length ||
          (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
      );
    const parts: Buffer[] = [];
    let offset = 0;
    while (true) {
      let next: (typeof candidates)[number] | undefined;
      for (const candidate of candidates) {
        if (candidate.index >= 0 && candidate.index < offset)
          candidate.index = value.indexOf(candidate.needle, offset);
        if (
          candidate.index >= 0 &&
          (next === undefined || candidate.index < next.index)
        )
          next = candidate;
      }
      if (next === undefined) break;
      parts.push(value.subarray(offset, next.index), next.marker);
      offset = next.index + next.needle.length;
    }
    if (parts.length === 0) return value;
    parts.push(value.subarray(offset));
    return Buffer.concat(parts);
  }

  /** Remove only declared secret values from one URL and report that action. */
  sanitizeUrl(value: string): SanitizedBrowserUrl {
    let output = value;
    const replacements = [...this.values].sort(
      ([leftId, left], [rightId, right]) =>
        right.length - left.length ||
        (leftId < rightId ? -1 : leftId > rightId ? 1 : 0),
    );
    for (const [id, secret] of replacements) {
      if (secret === "") continue;
      const marker = `${REDACTION_PREFIX}${id}]`;
      for (const candidate of encodedSecretValues(secret))
        output = output.replaceAll(candidate, marker);
    }
    const sanitized = sanitizeBrowserUrl(output);
    return {
      ...sanitized,
      redacted: sanitized.redacted || output !== value,
    };
  }

  fingerprint(value: string): BrowserStorageValueFingerprint {
    for (const secret of this.values.values())
      if (secret !== "" && value.includes(secret))
        return { value_state: "redacted-secret", value_sha256: null };
    return {
      value_state: "hashed",
      value_sha256: createHash("sha256")
        .update(this.redact(value))
        .digest("hex"),
    };
  }
}
