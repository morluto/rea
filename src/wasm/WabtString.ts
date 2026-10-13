/** Decode a producer WAT string to frame objdump's raw display text. */
export const watString = (form: string, start: number) => {
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
