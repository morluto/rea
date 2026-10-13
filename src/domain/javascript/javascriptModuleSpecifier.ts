/** Relative module syntax differs from an arbitrary dot-prefixed filename. */
export const isRelativeJavaScriptModuleSpecifier = (value: string): boolean =>
  value === "." ||
  value === ".." ||
  value.startsWith("./") ||
  value.startsWith("../");
