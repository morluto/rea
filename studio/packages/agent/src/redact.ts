/**
 * Replaces known secret values (API keys, target passwords, cookie values)
 * in any text before it is logged, stored as an event or sent to a model.
 */
export class Redactor {
  readonly #needles: readonly { value: string; label: string }[];

  constructor(secrets: readonly { value: string; label: string }[]) {
    const needles = new Map<string, string>();
    for (const { value, label } of secrets) {
      if (value.length === 0) continue;
      needles.set(value, label);
      // Secrets embedded in JSON appear with their escapes.
      const escaped = JSON.stringify(value).slice(1, -1);
      if (escaped !== value) needles.set(escaped, label);
      const encoded = encodeURIComponent(value);
      if (encoded !== value) needles.set(encoded, label);
    }
    this.#needles = [...needles.entries()]
      .map(([value, label]) => ({ value, label }))
      .sort((a, b) => b.value.length - a.value.length);
  }

  redact(text: string): string {
    let result = text;
    for (const { value, label } of this.#needles) {
      if (result.includes(value)) {
        result = result.split(value).join(`[REDACTED:${label}]`);
      }
    }
    return result;
  }

  /** Redact every string inside a JSON-compatible value. */
  redactValue<T>(value: T): T {
    return JSON.parse(this.redact(JSON.stringify(value) ?? "null")) as T;
  }
}
