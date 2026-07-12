/** Parse bounded imports/exports from dyld_info's line-oriented tables. */
export const parseDyldSymbols = (output: string, mode: "imports" | "exports") =>
  output.split(/\r?\n/u).flatMap((rawLine) => {
    const line = rawLine.trim();
    if (
      line.length === 0 ||
      /^(?:imports|exports|binding|address|segment|ordinal)\b/iu.test(line)
    )
      return [];
    const tokens = line.split(/\s+/u);
    const name = tokens.at(-1);
    if (name === undefined || !/^(?:_|\$s|objc_|swift_)/u.test(name)) return [];
    const addressToken = tokens.find((token) =>
      /^0x[a-fA-F0-9]+$/u.test(token),
    );
    return [
      {
        name,
        address: addressToken ?? null,
        weak: /\bweak\b/iu.test(line) ? true : null,
        reexport: /\bre-?export\b/iu.test(line)
          ? true
          : mode === "exports"
            ? false
            : null,
        source: mode === "imports" ? (tokens.at(-2) ?? null) : null,
      },
    ];
  });
