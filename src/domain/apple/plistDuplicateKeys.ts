/**
 * Keys a property list declares more than once within one dictionary.
 *
 * A decoded dictionary holds one value per key, so a repeated declaration
 * replaces an earlier one. The decoder that sees each dictionary's source keys
 * records them here before that collapse.
 */
export interface PlistDuplicateKeys {
  /** Dictionaries that declare at least one key more than once. */
  readonly dictionaries: number;
  /** Declarations replaced by a later declaration of the same key. */
  readonly replaced: number;
  /** The first distinct repeated key names, in source order. */
  readonly names: readonly string[];
  /** Whether a further distinct repeated name exists beyond `names`. */
  readonly namesOmitted: boolean;
}

/** Repeated key names kept for the limitation text; the counts stay exact. */
const NAMED_DUPLICATE_KEYS = 8;
/** UTF-16 units of one key shown in the limitation; longer keys are shortened. */
const SHOWN_KEY_LENGTH = 64;

/** Receives each dictionary's source keys before the decoder collapses them. */
export interface PlistDuplicateKeyCollector {
  /** Record one dictionary's keys in source order. */
  dictionary(keys: Iterable<string>): void;
  result(): PlistDuplicateKeys;
}

/** Collect repeated keys across the dictionaries of one decode. */
export const createPlistDuplicateKeyCollector =
  (): PlistDuplicateKeyCollector => {
    let dictionaries = 0;
    let replaced = 0;
    const names = new Set<string>();
    let namesOmitted = false;
    return {
      /** Record one dictionary's keys in source order. */
      dictionary(keys: Iterable<string>): void {
        const seen = new Set<string>();
        let repeated = false;
        for (const key of keys) {
          if (!seen.has(key)) {
            seen.add(key);
            continue;
          }
          repeated = true;
          replaced += 1;
          if (names.size < NAMED_DUPLICATE_KEYS) names.add(key);
          else if (!names.has(key)) namesOmitted = true;
        }
        if (repeated) dictionaries += 1;
      },
      result(): PlistDuplicateKeys {
        return { dictionaries, replaced, names: [...names], namesOmitted };
      },
    };
  };

/** One key as shown in the limitation, marked when shortened. */
const shownKey = (name: string): string =>
  name.length <= SHOWN_KEY_LENGTH
    ? JSON.stringify(name)
    : `${JSON.stringify(name.slice(0, SHOWN_KEY_LENGTH))} (shortened from ${String(name.length)} characters)`;

/** The decode limitation for repeated keys, or none when no key repeats. */
export const plistDuplicateKeyLimitations = (
  duplicates: PlistDuplicateKeys,
): string[] =>
  duplicates.replaced === 0
    ? []
    : [
        `${String(duplicates.dictionaries)} dictionary(ies) declare a key more than once (${duplicates.names.map(shownKey).join(", ")}${duplicates.namesOmitted ? ", ..." : ""}). REA kept the last value for each key; ${String(duplicates.replaced)} earlier value(s) are not reported, and other plist readers may keep a different one.`,
      ];
