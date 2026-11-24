export default {
  meta: {
    type: "problem",
    docs: {
      description: "Keep domain ordering independent of the host locale.",
    },
    schema: [],
    messages: {
      locale:
        "Use compareUnicodeCodePoints instead of localeCompare for domain ordering.",
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        const member = node.callee;
        if (member.type !== "MemberExpression") return;
        if (
          (!member.computed &&
            member.property.type === "Identifier" &&
            member.property.name === "localeCompare") ||
          (member.computed &&
            member.property.type === "Literal" &&
            member.property.value === "localeCompare") ||
          (member.computed &&
            member.property.type === "TemplateLiteral" &&
            member.property.expressions.length === 0 &&
            member.property.quasis[0]?.value.cooked === "localeCompare")
        )
          context.report({ node, messageId: "locale" });
      },
    };
  },
};
