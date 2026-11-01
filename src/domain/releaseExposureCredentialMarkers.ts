/** High-precision credential markers for an owner-side release audit. */

const MARKER_RULES = [
  {
    id: "pem.private_key",
    pattern:
      /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY(?: BLOCK)?-----/u,
  },
  { id: "aws.access_key_id", pattern: /\bAKIA[0-9A-Z]{16}\b/u },
  { id: "github.token", pattern: /\bgh[opurs]_[A-Za-z0-9]{36}\b/u },
  {
    id: "github.fine_grained_pat",
    pattern: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/u,
  },
  { id: "gitlab.pat", pattern: /\bglpat-[A-Za-z0-9_-]{20,}\b/u },
  { id: "slack.token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/u },
  { id: "stripe.live_secret", pattern: /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}\b/u },
  { id: "google.api_key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/u },
  { id: "npm.token", pattern: /\bnpm_[A-Za-z0-9]{36}\b/u },
] as const;

/** Rule ids this scanner can report. Matched bytes are never returned. */
export const CREDENTIAL_MARKER_RULE_IDS = MARKER_RULES.map((rule) => rule.id);

/** A hit records the rule and where it matched. It does not record the bytes. */
export interface CredentialMarkerHit {
  readonly rule_id: (typeof CREDENTIAL_MARKER_RULE_IDS)[number];
  readonly path: string;
  readonly line: number;
}

export interface CredentialMarkerScan {
  readonly hits: readonly CredentialMarkerHit[];
  readonly omitted_hits: number;
}

const HIT_LIMIT = 32;

/**
 * Scan one text member line by line.
 * The returned value contains rule ids, paths, and 1-based line numbers only.
 */
export const scanCredentialMarkers = (
  text: string,
  path: string,
): CredentialMarkerScan => {
  const hits: CredentialMarkerHit[] = [];
  let omittedHits = 0;
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    for (const rule of MARKER_RULES) {
      if (!rule.pattern.test(line)) continue;
      if (hits.length >= HIT_LIMIT) omittedHits += 1;
      else
        hits.push({
          rule_id: rule.id,
          path,
          line: index + 1,
        });
    }
  }
  return { hits, omitted_hits: omittedHits };
};
