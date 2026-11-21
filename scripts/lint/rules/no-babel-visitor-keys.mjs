import { findBinding } from "../bindings.mjs";

const nameOf = (node) =>
  node.type === "Identifier"
    ? node.name
    : node.type === "Literal"
      ? node.value
      : node.type === "TemplateLiteral" && node.expressions.length === 0
        ? node.quasis[0]?.value.cooked
        : undefined;

export default {
  meta: {
    type: "problem",
    docs: { description: "Keep Babel child expansion in its shared owner." },
    schema: [],
    messages: {
      owner:
        "Use childNodes or traverseJavaScriptAst instead of Babel VISITOR_KEYS.",
    },
  },
  create(context) {
    const source = context.sourceCode;
    const isBabelNamespace = (node) => {
      if (node?.type !== "Identifier") return false;
      const definition = findBinding(source, node)?.defs[0];
      if (
        definition?.type !== "ImportBinding" ||
        definition.node.type !== "ImportNamespaceSpecifier"
      )
        return false;
      const declaration = definition.parent ?? definition.node.parent;
      return declaration?.source?.value === "@babel/types";
    };
    return {
      ImportSpecifier(node) {
        if (
          node.parent.source.value === "@babel/types" &&
          (node.imported.name ?? node.imported.value) === "VISITOR_KEYS"
        )
          context.report({ node, messageId: "owner" });
      },
      ExportNamedDeclaration(node) {
        if (node.source?.value !== "@babel/types") return;
        for (const specifier of node.specifiers)
          if (
            specifier.type === "ExportSpecifier" &&
            nameOf(specifier.local) === "VISITOR_KEYS"
          )
            context.report({ node: specifier, messageId: "owner" });
      },
      MemberExpression(node) {
        if (
          (!node.computed || node.property.type !== "Identifier") &&
          nameOf(node.property) === "VISITOR_KEYS" &&
          isBabelNamespace(node.object)
        )
          context.report({ node, messageId: "owner" });
      },
      VariableDeclarator(node) {
        if (node.id.type !== "ObjectPattern" || !isBabelNamespace(node.init))
          return;
        for (const property of node.id.properties)
          if (
            property.type === "Property" &&
            (!property.computed || property.key.type !== "Identifier") &&
            nameOf(property.key) === "VISITOR_KEYS"
          )
            context.report({ node: property, messageId: "owner" });
      },
    };
  },
};
