/** Extract exact top-level WABT WAT forms; no binary decoding or name unescaping. */
export const parseWabtWat = (text: string) => {
  if (!/^\(module(?:\s|\))/u.test(text))
    throw new Error("Unsupported WABT WAT module prefix.");
  const imports: string[] = [];
  const exports: string[] = [];
  let depth = 0;
  let start = 0;
  let quoted = false;
  let commentDepth = 0;
  let lineComment = false;
  let closed = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    const next = text[index + 1];
    if (lineComment) {
      if (char === "\n") lineComment = false;
      continue;
    }
    if (quoted) {
      if (char === "\\") index++;
      else if (char === '"') quoted = false;
      continue;
    }
    if (commentDepth > 0) {
      if (char === "(" && next === ";") {
        commentDepth++;
        index++;
      } else if (char === ";" && next === ")") {
        commentDepth--;
        index++;
      }
      continue;
    }
    if (char === ";" && next === ";") {
      lineComment = true;
      index++;
      continue;
    }
    if (char === "(" && next === ";") {
      commentDepth++;
      index++;
      continue;
    }
    if (char === '"') {
      if (depth === 0)
        throw new Error("Unexpected string outside WABT WAT module.");
      quoted = true;
      continue;
    }
    if (char === "(") {
      if (closed) throw new Error("Unexpected second WABT WAT module.");
      depth++;
      if (depth === 2) start = index;
    } else if (char === ")") {
      if (depth === 2) {
        const form = text.slice(start, index + 1);
        if (/^\(import\s/u.test(form)) imports.push(form);
        else if (/^\(export\s/u.test(form)) exports.push(form);
      }
      if (--depth < 0) throw new Error("Unbalanced WABT WAT output.");
      if (depth === 0) closed = true;
    } else if (depth === 0 && char !== undefined && !/\s/u.test(char))
      throw new Error("Unexpected text outside WABT WAT module.");
  }
  if (depth !== 0 || quoted || commentDepth !== 0)
    throw new Error("Incomplete WABT WAT output.");
  return { imports, exports };
};
