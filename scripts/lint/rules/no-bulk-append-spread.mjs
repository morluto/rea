const bulkMethods = new Set(["push", "unshift", "splice"]);

const unwrap = (node) =>
  node?.type === "ChainExpression" ? node.expression : node;

const propertyName = (member) => {
  if (!member.computed && member.property.type === "Identifier")
    return member.property.name;
  if (member.computed && member.property.type === "Literal")
    return member.property.value;
  return undefined;
};

export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "Append collections element-wise instead of spreading them into call arguments.",
    },
    schema: [],
    messages: {
      spread:
        "Spreading into {{method}}() makes each element a call argument, and engines bound argument count by stack size, so a data-sized collection throws RangeError. Use appendAll from src/domain/arrayAppend.ts, or document the structural bound in a disable comment.",
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        const callee = unwrap(node.callee);
        if (callee?.type !== "MemberExpression") return;
        const method = propertyName(callee);
        if (!bulkMethods.has(method)) return;
        for (const argument of node.arguments)
          if (argument.type === "SpreadElement")
            context.report({
              node: argument,
              messageId: "spread",
              data: { method },
            });
      },
    };
  },
};
