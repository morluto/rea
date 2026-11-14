import { findBinding } from "../bindings.mjs";

const FS_PROMISES = new Set(["node:fs/promises", "fs/promises"]);
const FS = new Set(["node:fs", "fs"]);

const unwrap = (node) => {
  let current = node;
  while (
    current?.type === "AwaitExpression" ||
    current?.type === "TSAsExpression" ||
    current?.type === "TSNonNullExpression" ||
    current?.type === "TSSatisfiesExpression" ||
    current?.type === "ParenthesizedExpression" ||
    current?.type === "ChainExpression"
  )
    current = current.argument ?? current.expression;
  return current;
};

/** The module and imported name an identifier binds to, when it is an import. */
const importedFrom = (sourceCode, identifier) => {
  const definition = findBinding(sourceCode, identifier)?.defs?.[0];
  if (definition?.type !== "ImportBinding") return undefined;
  const declaration = definition.parent;
  const specifier = definition.node;
  return {
    source: declaration?.source?.value,
    imported:
      specifier.type === "ImportSpecifier"
        ? (specifier.imported.name ?? specifier.imported.value)
        : "*",
  };
};

/** `name(...)` or `namespace.name(...)` imported from one of `modules`. */
const callsImport = (sourceCode, call, modules, names) => {
  if (call?.type !== "CallExpression") return false;
  const callee = unwrap(call.callee);
  if (callee?.type === "Identifier") {
    const binding = importedFrom(sourceCode, callee);
    return (
      binding !== undefined &&
      modules.has(binding.source) &&
      names.has(binding.imported)
    );
  }
  if (
    callee?.type === "MemberExpression" &&
    !callee.computed &&
    names.has(callee.property.name) &&
    callee.object.type === "Identifier"
  ) {
    const binding = importedFrom(sourceCode, callee.object);
    return (
      binding !== undefined &&
      binding.imported === "*" &&
      modules.has(binding.source)
    );
  }
  return false;
};

const OPEN = new Set(["open"]);
const DESCRIPTOR_CLOSE = new Set(["close", "closeSync"]);

/** Whether an expression evaluates to a FileHandle from fs/promises open(). */
const opensFileHandle = (sourceCode, expression) => {
  const value = unwrap(expression);
  if (callsImport(sourceCode, value, FS_PROMISES, OPEN)) return true;
  // open(...).catch(...) still resolves to the opened handle.
  return (
    value?.type === "CallExpression" &&
    value.callee.type === "MemberExpression" &&
    !value.callee.computed &&
    value.callee.property.name === "catch" &&
    callsImport(sourceCode, unwrap(value.callee.object), FS_PROMISES, OPEN)
  );
};

/** Whether a type annotation names fs/promises' FileHandle, alone or in a union. */
const namesFileHandle = (sourceCode, annotation) => {
  const type = annotation?.typeAnnotation ?? annotation;
  if (type?.type === "TSUnionType")
    return type.types.some((member) => namesFileHandle(sourceCode, member));
  if (type?.type !== "TSTypeReference") return false;
  const name = type.typeName;
  if (name?.type === "Identifier") {
    const binding = importedFrom(sourceCode, name);
    return (
      binding !== undefined &&
      FS_PROMISES.has(binding.source) &&
      binding.imported === "FileHandle"
    );
  }
  // fsp.FileHandle through a namespace import.
  if (name?.type === "TSQualifiedName" && name.right.name === "FileHandle") {
    const binding =
      name.left.type === "Identifier"
        ? importedFrom(sourceCode, name.left)
        : undefined;
    return (
      binding !== undefined &&
      binding.imported === "*" &&
      FS_PROMISES.has(binding.source)
    );
  }
  return false;
};

/** A class field declared as a FileHandle, for `this.field.close()`. */
const fieldHoldsFileHandle = (sourceCode, member) => {
  if (
    member.type !== "MemberExpression" ||
    member.computed ||
    member.object.type !== "ThisExpression"
  )
    return false;
  const property = member.property;
  for (let node = member.parent; node; node = node.parent) {
    if (node.type !== "ClassBody") continue;
    return node.body.some(
      (element) =>
        element.type === "PropertyDefinition" &&
        element.key.type === property.type &&
        element.key.name === property.name &&
        (namesFileHandle(sourceCode, element.typeAnnotation) ||
          opensFileHandle(sourceCode, element.value)),
    );
  }
  return false;
};

/** Whether `identifier` is a variable declared or ever assigned as a FileHandle. */
const holdsFileHandle = (sourceCode, identifier) => {
  const variable = findBinding(sourceCode, identifier);
  if (variable === undefined) return false;
  for (const definition of variable.defs ?? []) {
    if (namesFileHandle(sourceCode, definition.name?.typeAnnotation))
      return true;
    if (
      definition.node?.type === "VariableDeclarator" &&
      opensFileHandle(sourceCode, definition.node.init)
    )
      return true;
  }
  for (const reference of variable.references ?? []) {
    const parent = reference.identifier?.parent;
    if (
      parent?.type === "AssignmentExpression" &&
      parent.left === reference.identifier &&
      opensFileHandle(sourceCode, parent.right)
    )
      return true;
  }
  return false;
};

export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "Close file handles and descriptors only through the src/filesystem/Owned* owners.",
    },
    schema: [],
    messages: {
      raw: "Close file handles and descriptors through OwnedFileHandle or withOwnedFileHandle (src/filesystem), which retain a failed close instead of losing it or masking the operation's own failure.",
    },
  },
  create(context) {
    const { sourceCode } = context;
    return {
      CallExpression(node) {
        if (callsImport(sourceCode, node, FS, DESCRIPTOR_CLOSE)) {
          context.report({ node, messageId: "raw" });
          return;
        }
        const callee = node.callee;
        if (
          callee.type !== "MemberExpression" ||
          callee.computed ||
          callee.property.name !== "close"
        )
          return;
        const target = unwrap(callee.object);
        if (
          (target?.type === "Identifier" &&
            holdsFileHandle(sourceCode, target)) ||
          fieldHoldsFileHandle(sourceCode, target) ||
          opensFileHandle(sourceCode, target)
        )
          context.report({ node, messageId: "raw" });
      },
    };
  },
};
