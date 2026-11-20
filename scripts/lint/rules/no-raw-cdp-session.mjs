const RAW_SESSION_FACTORIES = new Set([
  "newCDPSession",
  "newBrowserCDPSession",
]);

const propertyName = (member) => {
  if (!member.computed && member.property.type === "Identifier")
    return member.property.name;
  if (member.computed && member.property.type === "Literal")
    return typeof member.property.value === "string"
      ? member.property.value
      : undefined;
  return undefined;
};

export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "Open Playwright CDP sessions only through the registered-command owner.",
    },
    schema: [],
    messages: {
      raw: "Use newPlaywrightCdpSession so every command is registered and every reply is admitted by its result schema.",
    },
  },
  create(context) {
    return {
      MemberExpression(node) {
        const name = propertyName(node);
        if (name !== undefined && RAW_SESSION_FACTORIES.has(name))
          context.report({ node, messageId: "raw" });
      },
    };
  },
};
