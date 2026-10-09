/** Source whose concatenated alternatives exceed primitive candidate storage. */
export const primitiveCandidateExpansionSource = (): string => {
  const expression = Array.from(
    { length: 20 },
    () => '(true ? "a" : "b")',
  ).join(" + ");
  return `const answer = { nested: ${expression} };`;
};

/** Source whose repeated doubling exceeds derived primitive string storage. */
export const primitiveByteExpansionSource = (): string => {
  const declarations = ['const value0 = "x";'];
  for (let index = 1; index <= 30; index += 1) {
    const previous = `value${String(index - 1)}`;
    declarations.push(
      `const value${String(index)} = ${previous} + ${previous};`,
    );
  }
  declarations.push("const answer = value30;");
  return declarations.join("\n");
};
