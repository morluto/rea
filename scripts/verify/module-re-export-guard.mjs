import { tokenize } from "./source-tokens.mjs";

/** Count forwarding declarations, including named namespaces and type-only exports. */
export const moduleReExportCount = (source) => {
  const { tokens } = tokenize(source);
  let count = 0;
  for (let at = 0; at < tokens.length; at += 1) {
    if (tokens[at]?.text !== "export") continue;
    let next = at + 1;
    if (tokens[next]?.text === "type") next += 1;

    if (tokens[next]?.text === "*") {
      next += 1;
      if (tokens[next]?.text === "as") {
        const name = tokens[next + 1];
        if (name?.kind !== "id" && name?.kind !== "string") continue;
        next += 2;
      }
    } else if (tokens[next]?.text === "{") {
      next += 1;
      while (next < tokens.length && tokens[next]?.text !== "}") next += 1;
      next += 1;
    } else continue;

    const specifier = tokens[next + 1];
    if (
      tokens[next]?.text === "from" &&
      specifier?.kind === "string" &&
      (source[specifier.start] === '"' || source[specifier.start] === "'")
    )
      count += 1;
  }
  return count;
};
