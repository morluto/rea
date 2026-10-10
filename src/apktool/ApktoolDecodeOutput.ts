/**
 * Parsers for the decoded workspace `apktool d --no-src` produces.
 *
 * Apktool's apktool.yml is a small YAML document; the facts REA projects
 * are flat enough that line-oriented extraction stays honest without a
 * YAML dependency, and unrecognized content is ignored rather than guessed.
 */

export interface ApktoolMetadata {
  readonly versionName: string | null;
  readonly versionCode: string | null;
  readonly minSdkVersion: string | null;
  readonly targetSdkVersion: string | null;
}

/**
 * Project version and SDK facts from apktool.yml. Values keep apktool's
 * own spelling (version codes can print as `45` or `45.1`).
 */
export const parseApktoolYml = (yml: string): ApktoolMetadata => {
  const metadata: {
    versionName: string | null;
    versionCode: string | null;
    minSdkVersion: string | null;
    targetSdkVersion: string | null;
  } = {
    versionName: null,
    versionCode: null,
    minSdkVersion: null,
    targetSdkVersion: null,
  };
  for (const line of yml.split(/\r?\n/u)) {
    const versionName = /^\s*versionName:\s*(?:'([^']*)'|(.*))$/u.exec(line);
    if (versionName !== null && metadata.versionName === null)
      metadata.versionName = (versionName[1] ?? versionName[2] ?? "").trim();
    const versionCode = /^\s*versionCode:\s*(?:'([^']*)'|(.*))$/u.exec(line);
    if (versionCode !== null && metadata.versionCode === null)
      metadata.versionCode = (versionCode[1] ?? versionCode[2] ?? "").trim();
    const minSdk = /minSdkVersion:\s*'?([0-9]+)'?/u.exec(line);
    if (minSdk !== null && metadata.minSdkVersion === null)
      metadata.minSdkVersion = minSdk[1]!;
    const targetSdk = /targetSdkVersion:\s*'?([0-9]+)'?/u.exec(line);
    if (targetSdk !== null && metadata.targetSdkVersion === null)
      metadata.targetSdkVersion = targetSdk[1]!;
  }
  return metadata;
};

/** Read the package attribute from decoded AndroidManifest.xml text. */
export const parseManifestPackage = (manifest: string): string | null => {
  const match = /<manifest[^>]*\spackage="([^"]+)"/u.exec(manifest);
  return match === null ? null : match[1]!;
};

export interface DecodedStringEntry {
  readonly name: string;
  readonly value: string;
}

/**
 * Project `<string name="...">value</string>` entries from one decoded
 * strings.xml. Values are preserved exactly as apktool printed them —
 * escaped entities stay escaped — and entries containing nested markup
 * are counted as unparsed rather than flattened.
 */
export const parseDecodedStrings = (
  stringsXml: string,
): {
  entries: readonly DecodedStringEntry[];
  unparsedCount: number;
} => {
  const entries: DecodedStringEntry[] = [];
  let unparsedCount = 0;
  const pattern = /<string\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/string>/gu;
  for (
    let match = pattern.exec(stringsXml);
    match !== null;
    match = pattern.exec(stringsXml)
  ) {
    const value = match[2]!;
    if (value.includes("<")) {
      unparsedCount += 1;
      continue;
    }
    entries.push({ name: match[1]!, value: value.trim() });
  }
  return { entries, unparsedCount };
};
