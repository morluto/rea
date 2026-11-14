import { findBinding } from "../bindings.mjs";

const unwrap = (node) =>
  node?.type === "ChainExpression" ? node.expression : node;

const propertyName = (member) => {
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
const isVitestExport = (sourceCode, node, name) => {
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

const isVitestMethod = (sourceCode, callee, receiver, method) => {
  const member = unwrap(callee);
  return (
    member?.type === "MemberExpression" &&
    propertyName(member) === method &&
    isVitestExport(sourceCode, member.object, receiver)
  );
};

const keyName = (property) => {
  if (!property.computed) return property.key.name ?? property.key.value;
  return property.key.type === "Literal" ? property.key.value : undefined;
};

/**
 * A wait timeout the call may set: a number or other non-literal options, an
 * options `timeout` (including a literal computed key), or a spread whose
 * properties the rule cannot see.
 */
const explicitTimeout = (options) => {
  if (options === undefined) return undefined;
  if (options.type !== "ObjectExpression") return options;
  return options.properties.find(
    (property) =>
      property.type === "SpreadElement" ||
      (property.type === "Property" &&
        (property.computed && property.key.type !== "Literal"
          ? true
          : keyName(property) === "timeout")),
  );
};

export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "Keep test wait deadlines owned by the project test deadline policy.",
    },
    schema: [],
    messages: {
      viWaitFor:
        "vi.waitFor defaults to a one-second host-speed guess; use waitFor from tests/support/testWait.ts, which the test deadline policy bounds.",
      pollTimeout:
        "The project owns expect.poll's deadline; remove this timeout. When promptness is the behavior under test, assert elapsed time or order the condition before a release gate instead.",
    },
  },
  create(context) {
    const sourceCode = context.sourceCode;
    return {
      CallExpression(node) {
        if (isVitestMethod(sourceCode, node.callee, "vi", "waitFor")) {
          context.report({ node, messageId: "viWaitFor" });
          return;
        }
        if (!isVitestMethod(sourceCode, node.callee, "expect", "poll")) return;
        const timeout = explicitTimeout(node.arguments[1]);
        if (timeout !== undefined)
          context.report({ node: timeout, messageId: "pollTimeout" });
      },
    };
  },
};
