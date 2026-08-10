import { createHash } from "node:crypto";

import type {
  BrowserScenario,
  BrowserScenarioUrl,
  BrowserScenarioValue,
} from "../domain/browserScenario.js";
import type { BrowserStorageValueFingerprint } from "../domain/browserScenarioCaptureValues.js";

const REDACTION_PREFIX = "[REDACTED:";

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
      if (value === undefined) return undefined;
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
