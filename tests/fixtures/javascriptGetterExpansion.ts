/** Dynamic receiver keys enumerate permutations of these getter names. */
export const getterExpansionSource = (count = 10): string => `
  const shared = { value: 1 };
  class Request {
    ${Array.from(
      { length: count },
      (_, index) => `get field${index}() { return this[key].field${index}; }`,
    ).join("\n")}
    get state() { return shared; }
  }
  consume(new Request().field0);
  const result = shared.value;
`;

export const plainGetterSource = (
  count: number,
  object = false,
  fields = false,
): string => {
  const getters = Array.from(
    { length: count },
    (_, index) => `get g${index}() { return this._g${index}; }`,
  ).join(object ? ",\n" : "\n");
  const receiver = object
    ? `const receiver = { ${getters} }; consume(receiver[key]);`
    : `class C { ${
        fields
          ? Array.from(
              { length: count },
              (_, index) => `_g${index} = { value: ${index} };`,
            ).join("\n")
          : ""
      }
        ${getters} } consume(new C()[key]);`;
  return `import imported from "dep"; ${receiver} const unrelated = 42;`;
};

export const bundledGetterSource = (classes = 20): string => `
  import imported from "dep";
  ${Array.from(
    { length: classes },
    (_, index) => `
    class C${index} {
      ${Array.from(
        { length: 10 },
        (_, field) => `get f${field}() { return this[M].f${field}; }`,
      ).join("\n")}
    }
    consume(new C${index}()[key]);
  `,
  ).join("\n")}
  const unrelated = 42;
`;

export const ordinaryConstructedEscapeSource = (
  getters: number,
  classes = 1,
  calls = 1,
  isStatic = false,
): string => {
  const repeat = (count: number, source: (index: number) => string) =>
    Array.from({ length: count }, (_, index) => source(index)).join("\n");
  const tail = 'import x from "dep"; const unrelated = 42;';
  if (classes > 1)
    return (
      repeat(
        classes,
        (owner) => `class K${owner} ${owner ? `extends K${owner - 1}` : ""} {
      ${repeat(getters, (index) => `get f${owner}_${index}() { return this[M].f${owner}_${(index + 1) % getters}; }`)}
    }`,
      ) + ` consume(new K${classes - 1}()); ${tail}`
    );
  const prefix = isStatic ? "static " : "";
  return `class C {
    ${repeat(getters, (index) => `${prefix}_g${index} = {}; ${prefix}get g${index}() { return this._g${index}; }`)}
  } ${repeat(calls, () => `consume(${isStatic ? "C" : "new C()"});`)} ${calls > 1 ? tail : ""}`;
};
