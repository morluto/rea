interface ParsedDyldSymbol {
  readonly name: string;
  readonly address: string | null;
  readonly weak: boolean | null;
  readonly reexport: boolean | null;
  readonly source: string | null;
}

/** Decode Apple dyld inventory rows, projecting export offsets to VM addresses. */
export const parseDyldSymbols = (
  output: string,
  mode: "imports" | "exports",
  imageBase: string | null = null,
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
    const reexport = /^\[re-export\]\s+(.+?)(?:\s+\(from (.+)\))?$/u.exec(line);
    if (reexport?.[1] !== undefined)
      return [
        {
          name: reexport[1],
          address: null,
          weak: null,
          reexport: true,
          source: reexport[2] ?? null,
        },
      ];
    const exported = /^(0x[\da-f]+)\s+(.+?)(?:\s+\[([^\]]+)\])?$/iu.exec(line);
    if (exported?.[1] === undefined || exported[2] === undefined) return [];
    const absolute = /\babsolute\b/u.test(exported[3] ?? "");
    const address =
      offsets && !absolute
        ? imageBase === null
          ? null
          : `0x${(BigInt(imageBase) + BigInt(exported[1])).toString(16)}`
        : canonicalHex(exported[1]);
    return [
      {
        name: exported[2],
        address,
        weak: /\bweak-def\b/u.test(exported[3] ?? "") ? true : null,
        reexport: false,
        source: null,
      },
    ];
  });
};

const canonicalHex = (value: string | undefined): string | null =>
  value === undefined ? null : `0x${BigInt(value).toString(16)}`;
