/** Decode a producer WAT string to frame objdump's raw display text. */
const watString = (form: string, start: number) => {
  let end = start;
  while (end < form.length && form[end] !== '"') {
    if (form[end] === "\\") end++;
    end++;
  }
  if (end === form.length)
    throw new Error("Incomplete WABT custom-section name.");
  const name = form.slice(start, end);
  // Escapes shrink; literal UTF-8 has the same byte extent as its source.
  const bytes = Buffer.alloc(Buffer.byteLength(name, "utf8"));
  let length = 0;
  for (let index = 0; index < name.length;) {
    if (name[index] !== "\\") {
      const next = name.indexOf("\\", index);
      const end = next < 0 ? name.length : next;
      length += bytes.write(name.slice(index, end), length, "utf8");
      index = end;
      continue;
    }
    const hex = name.slice(index + 1, index + 3);
    if (/^[\da-f]{2}$/iu.test(hex)) {
      bytes[length++] = Number.parseInt(hex, 16);
      index += 3;
    } else {
      const escape = name[index + 1];
      const value =
        escape === "t"
          ? 9
          : escape === "n"
            ? 10
            : escape === "r"
              ? 13
              : escape === '"'
                ? 34
                : escape === "\\"
                  ? 92
                  : undefined;
      if (value === undefined) throw new Error("Unsupported WABT name escape.");
      bytes[length++] = value;
      index += 2;
    }
  }
  return { bytes: bytes.subarray(0, length), end: end + 1 };
};

/** Read only module-name metadata from WABT's preserved name-section payload. */
const moduleNames = (bytes: Uint8Array): string[] => {
  const names: string[] = [];
  let offset = 0;
  const uint32 = (end: number): number => {
    let value = 0;
    for (let shift = 0; shift <= 28 && offset < end; shift += 7) {
      const byte = bytes[offset++];
      if (byte === undefined) break;
      if (shift === 28 && byte > 15) break;
      value += (byte & 127) * 2 ** shift;
      if (byte < 128) return value;
    }
    throw new Error("Incomplete WABT name-section metadata.");
  };
  while (offset < bytes.length) {
    const type = uint32(bytes.length);
    const size = uint32(bytes.length);
    const end = offset + size;
    if (end > bytes.length)
      throw new Error("Incomplete WABT name-section metadata.");
    if (type === 0 && size !== 0) {
      const length = uint32(end);
      if (offset + length !== end)
        throw new Error("Incomplete WABT module-name metadata.");
      names.push(
        new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
          bytes.subarray(offset, end),
        ),
      );
    }
    offset = end;
  }
  return names;
};

/** Extract exact top-level WABT WAT forms; no raw WASM decoding or import/export name unescaping. */
export const parseWabtWat = (text: string) => {
  if (!/^\(module(?:\s|\))/u.test(text))
    throw new Error("Unsupported WABT WAT module prefix.");
  const imports: string[] = [];
  const exports: string[] = [];
  const customSectionNames: string[] = [];
  const debugModuleNames: string[] = [];
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
        else if (/^\(@custom\s/u.test(form)) {
          const prefix = /^\(@custom\s+"/u.exec(form);
          if (prefix === null)
            throw new Error("Unsupported WABT custom-section name.");
          const nameString = watString(form, prefix[0].length);
          // A WASM name is length-delimited UTF-8; leading U+FEFF is name data.
          const name = new TextDecoder("utf-8", {
            fatal: true,
            ignoreBOM: true,
          }).decode(nameString.bytes);
          customSectionNames.push(name);
          if (name === "name") {
            const payloadPrefix = /^\s+"/u.exec(form.slice(nameString.end));
            if (payloadPrefix === null)
              throw new Error("Unsupported WABT name-section payload.");
            const payload = watString(
              form,
              nameString.end + payloadPrefix[0].length,
            );
            debugModuleNames.push(...moduleNames(payload.bytes));
          }
        }
      }
      if (--depth < 0) throw new Error("Unbalanced WABT WAT output.");
      if (depth === 0) closed = true;
    } else if (depth === 0 && char !== undefined && !/\s/u.test(char))
      throw new Error("Unexpected text outside WABT WAT module.");
  }
  if (depth !== 0 || quoted || commentDepth !== 0)
    throw new Error("Incomplete WABT WAT output.");
  return { imports, exports, customSectionNames, debugModuleNames };
};
