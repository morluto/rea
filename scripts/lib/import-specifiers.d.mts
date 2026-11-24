/** One static import or re-export specifier and its source line. */
export interface ImportSpecifierFact {
  readonly specifier: string;
  readonly line: number;
  /** True only when TypeScript erases this module edge under verbatimModuleSyntax. */
  readonly typeOnly: boolean;
}

/** Static string specifier on one import or re-export node, when it has one. */
export function importSpecifier(node: {
  readonly type: string;
}): string | undefined;

/**
 * Static import and re-export specifiers in source order.
 * Comments and string literals are not imports.
 */
export function readImportSpecifiers(
  source: string,
): readonly ImportSpecifierFact[];

/** One literal `importVerifierSource(specifier, import.meta.url)` source and its line. */
export interface VerifierSourceSpecifierFact {
  readonly specifier: string;
  readonly line: number;
}

/**
 * Sources loaded through `importVerifierSource(specifier, import.meta.url)`,
 * where the specifier is a literal or `new URL(literal, import.meta.url).href`.
 */
export function readVerifierSourceSpecifiers(
  source: string,
): readonly VerifierSourceSpecifierFact[];
