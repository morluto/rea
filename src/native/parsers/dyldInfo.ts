interface ParsedDyldSymbol {
  readonly name: string;
  readonly address: string | null;
  readonly weak: boolean | null;
  readonly reexport: boolean | null;
  readonly source: string | null;
  /** The source library's name for a symbol it re-exports under another name. */
  readonly sourceSymbol?: string;
}

/** Decode Apple dyld inventory rows, projecting export offsets to VM addresses. */
export const parseDyldSymbols = (
  output: string,
  mode: "imports" | "exports",
  imageBase: string | null = null,
  knownExportNames: ReadonlySet<string> = new Set(),
) => {
  const offsets = /^\s*offset\s+symbol\s*$/mu.test(output);
  return output.split(/\r?\n/u).flatMap<ParsedDyldSymbol>((rawLine) => {
    const line = rawLine.trim();
    if (mode === "imports") {
      const imported =
        /^(?:0x[\da-f]+\s+)?(.+?)(?:\s+\[([^\]]+)\])?\s+\(from (.+)\)$/iu.exec(
          line,
        );
      if (imported?.[1] !== undefined)
        return [
          {
            name: imported[1],
            address: null,
            weak: /\bweak-import\b/u.test(imported[2] ?? "") ? true : null,
            reexport: null,
            source: imported[3] ?? null,
          },
        ];
      return [];
    }
    // dyld_info prints `_sym (from lib)`, or `_new (_old from lib)` when the
    // source library names the symbol differently. Split the trailing
    // parenthesized suffix with string scans so a library path containing
    // " from ", or a source symbol containing parentheses such as
    // `operator()`, cannot pull the match into nested lazy quantifiers.
    const reexport = parseReexportRow(line, knownExportNames);
    if (reexport !== null)
      return [
        {
          name: reexport.name,
          address: null,
          weak: null,
          reexport: true,
          source: reexport.source,
          ...(reexport.sourceSymbol === undefined
            ? {}
            : { sourceSymbol: reexport.sourceSymbol }),
        },
      ];
    const exported = /^(0x[\da-f]+)\s+(.+?)(?:\s+\[([^\]]+)\])?$/iu.exec(line);
    if (exported?.[1] === undefined || exported[2] === undefined) return [];
    const rawName = /^0x[\da-f]+\s+(.+)$/iu.exec(line)?.[1];
    const literalName = rawName !== undefined && knownExportNames.has(rawName);
    // If nm establishes both interpretations, the textual row cannot bind an address or flags.
    // Let the caller retain the exact nm names without guessing which one owns this row.
    if (
      literalName &&
      exported[3] !== undefined &&
      knownExportNames.has(exported[2])
    )
      return [];
    const annotation = literalName ? undefined : exported[3];
    const absolute = /\babsolute\b/u.test(annotation ?? "");
    const address =
      offsets && !absolute
        ? imageBase === null
          ? null
          : `0x${(BigInt(imageBase) + BigInt(exported[1])).toString(16)}`
        : canonicalHex(exported[1]);
    return [
      {
        name: literalName ? rawName : exported[2],
        address,
        weak: /\bweak-def\b/u.test(annotation ?? "") ? true : null,
        reexport: false,
        source: null,
      },
    ];
  });
};

const canonicalHex = (value: string | undefined): string | null =>
  value === undefined ? null : `0x${BigInt(value).toString(16)}`;

interface ReexportRow {
  readonly name: string;
  readonly source: string | null;
  readonly sourceSymbol?: string;
}

/**
 * Split a `[re-export]` row without nested lazy quantifiers.
 *
 * Returns null when the line is not a re-export row so callers fall through
 * to the plain export parser. Known names disambiguate nested parentheses;
 * when that inventory is incomplete, retain the suffix-based fallback.
 */
const parseReexportRow = (
  line: string,
  knownNames: ReadonlySet<string>,
): ReexportRow | null => {
  const prefix = /^\[re-export\]\s+/u.exec(line);
  if (prefix === null) return null;
  const rest = line.slice(prefix[0].length);
  if (rest.length === 0) return null;
  if (!rest.endsWith(")")) return { name: rest, source: null };
  const candidates: ReexportRow[] = [];
  for (const match of rest.matchAll(/\s+\(/gu)) {
    const name = rest.slice(0, match.index);
    if (!knownNames.has(name)) continue;
    const parsed = reexportSuffix(
      name,
      rest.slice(match.index + match[0].length, -1),
    );
    if (parsed !== null) candidates.push(parsed);
  }
  // Exact nm identities establish a boundary even when names contain parentheses.
  // Competing known interpretations remain unknown rather than creating a new name.
  if (candidates.length > 0)
    return candidates.length === 1 ? candidates[0]! : null;
  if (knownNames.has(rest)) return { name: rest, source: null };
  let depth = 0;
  for (let index = rest.length - 1; index >= 0; index--) {
    if (rest[index] === ")") depth++;
    else if (rest[index] === "(" && --depth === 0) {
      if (index === 0 || !/\s/u.test(rest[index - 1]!)) break;
      const name = rest.slice(0, index).trimEnd();
      return (
        reexportSuffix(name, rest.slice(index + 1, -1)) ?? {
          name: rest,
          source: null,
        }
      );
    }
  }
  return { name: rest, source: null };
};

const reexportSuffix = (name: string, inner: string): ReexportRow | null => {
  if (name.length === 0) return null;
  if (inner.startsWith("from ") && inner.length > 5)
    return { name, source: inner.slice(5) };
  const separator = /\s+from /u.exec(inner);
  if (separator === null) return null;
  const sourceSymbol = inner.slice(0, separator.index);
  const source = inner.slice(separator.index + separator[0].length);
  return sourceSymbol.length > 0 && source.length > 0
    ? { name, source, sourceSymbol }
    : null;
};
