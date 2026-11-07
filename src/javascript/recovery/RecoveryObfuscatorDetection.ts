/** Signature occurrences observed in one selected input. */
export type RecoveryObfuscatorFacts = {
  readonly identifiers: number;
  readonly decoderCalls: number;
};

/**
 * Outputs from the `javascript-obfuscator` family rename bindings to `_0x`-hex
 * identifiers and route string literals through a rotated string array whose
 * decoder is called with hex offsets, for example `_0x1a2b3c(0x1f)`. Ordinary
 * minified bundles observed during verification (esbuild-minified dependencies)
 * contained neither pattern.
 */
const IDENTIFIER_PATTERN = /_0x[0-9a-f]{4,8}\b/gu;
const DECODER_PATTERN = /_0x[0-9a-f]{4,8}\(\s*0x[0-9a-f]+/gu;

/**
 * Minimum co-occurrence treated as a match. Each pattern alone is not a
 * signature; ordinary code that names a few identifiers `_0x…` without the
 * decoder calls stays undetected.
 */
const MIN_IDENTIFIERS = 4;
const MIN_DECODER_CALLS = 2;

/**
 * Count the family's signature occurrences in one selected input. Inputs are
 * validated UTF-8 before the engine runs, so decoding is lossless here.
 */
export const detectRecoveryObfuscatorFacts = (
  bytes: Buffer,
): RecoveryObfuscatorFacts | undefined => {
  const text = bytes.toString("utf8");
  const identifiers = (text.match(IDENTIFIER_PATTERN) ?? []).length;
  const decoderCalls = (text.match(DECODER_PATTERN) ?? []).length;
  return identifiers >= MIN_IDENTIFIERS && decoderCalls >= MIN_DECODER_CALLS
    ? { identifiers, decoderCalls }
    : undefined;
};

/**
 * Public limitation for one detected input. Detection is signature-based:
 * configurations that change the identifier generator (for example `mangled`)
 * are not covered.
 */
export const recoveryObfuscatorLimitation = (
  relativePath: string,
  facts: RecoveryObfuscatorFacts,
): string =>
  `Selected input ${relativePath} matches javascript-obfuscator-family signatures (${String(facts.identifiers)} _0x-hex identifier and ${String(facts.decoderCalls)} string-array decoder-call occurrences). Structural splitting is limited for this family; consider running external static deobfuscators (webcrack, obfuscator-io-deobfuscator, then humanify for identifier renaming) on the published copy under inputs/ and re-ingesting that output with recover_javascript_sources. REA does not install or run these tools.`;
