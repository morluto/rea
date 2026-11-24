/** Resolve the lexical binding instead of treating a matching name as an API. */
export const findBinding = (sourceCode, identifier) => {
  for (
    let scope = sourceCode.getScope(identifier);
    scope !== null;
    scope = scope.upper
  ) {
    const variable = scope.set.get(identifier.name);
    if (variable !== undefined) return variable;
  }
  return undefined;
};

export const unwrap = (node) =>
  node?.type === "ChainExpression" ? node.expression : node;

export const propertyName = (member) => {
  if (!member?.computed && member?.property?.type === "Identifier")
    return member.property.name;
  if (member?.computed && member.property?.type === "Literal")
    return member.property.value;
  return undefined;
};

/** The `vitest` import specifier a local identifier is bound to, if any. */
const vitestImport = (sourceCode, identifier) => {
  const definition = findBinding(sourceCode, identifier)?.defs[0];
  if (definition?.type !== "ImportBinding") return undefined;
  const declaration = definition.parent ?? definition.node.parent;
  if (declaration?.source?.value !== "vitest") return undefined;
  return definition.node;
};

/** Whether `node` is Vitest's `name` export: `name` or `vitest.name`. */
export const isVitestExport = (sourceCode, node, name) => {
  const target = unwrap(node);
  if (target?.type === "Identifier") {
    const specifier = vitestImport(sourceCode, target);
    return (
      specifier?.type === "ImportSpecifier" &&
      (specifier.imported.name ?? specifier.imported.value) === name
    );
  }
  return (
    target?.type === "MemberExpression" &&
    propertyName(target) === name &&
    target.object?.type === "Identifier" &&
    vitestImport(sourceCode, target.object)?.type === "ImportNamespaceSpecifier"
  );
};
