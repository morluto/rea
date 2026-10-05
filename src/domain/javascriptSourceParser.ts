import { parse } from "@babel/parser";

/** Babel AST produced by REA's inert JavaScript parser boundary. */
export type ParsedJavaScriptSource = ReturnType<typeof parse>;

/** Parse JavaScript or TypeScript once without retaining unused comment nodes. */
export const parseJavaScriptSource = (
  source: string,
): ParsedJavaScriptSource | null => {
  try {
    return parse(source, {
      sourceType: "unambiguous",
      errorRecovery: true,
      attachComment: false,
      // "decorators-legacy" admits both the standard and the legacy decorator
      // forms, including parameter decorators. Without it a decorated
      // TypeScript source fails to parse at all rather than reporting
      // recovered syntax, which loses every fact derived from that source.
      plugins: ["decorators-legacy", "jsx", "typescript"],
    });
  } catch {
    return null;
  }
};
