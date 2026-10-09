import { parse, type ParserPlugin } from "@babel/parser";

/** Babel AST produced by REA's inert JavaScript parser boundary. */
export type ParsedJavaScriptSource = ReturnType<typeof parse>;

/** Parse JavaScript or TypeScript once without attaching comments to AST nodes. */
export const parseJavaScriptSource = (
  source: string,
  sourcePath?: string,
): ParsedJavaScriptSource | null => {
  const path = sourcePath ?? "";
  const isMts = /\.mts$/iu.test(path);
  const typescript: ParserPlugin = [
    "typescript",
    {
      dts: /\.d\.(?:ts|mts|cts)$/iu.test(path),
      ...(isMts ? { disallowAmbiguousJSXLike: true } : {}),
    },
  ];
  try {
    return parse(source, {
      sourceType: "unambiguous",
      errorRecovery: true,
      attachComment: false,
      // "decorators-legacy" admits both the standard and the legacy decorator
      // forms, including parameter decorators. Without it a decorated
      // TypeScript source fails to parse at all rather than reporting
      // recovered syntax, which loses every fact derived from that source.
      // TypeScript's .mts mode disables JSX and rejects ambiguous angle syntax.
      // Plain .ts and .cts artifacts admit angle-bracket type assertions instead of JSX.
      // Unknown paths retain the existing JSX-capable parser contract.
      plugins: /\.(?:ts|cts|mts)$/iu.test(path)
        ? ["decorators-legacy", typescript]
        : ["decorators-legacy", "jsx", typescript],
    });
  } catch (cause: unknown) {
    // Unparseable source is represented by the null return.
    void cause;
    return null;
  }
};
