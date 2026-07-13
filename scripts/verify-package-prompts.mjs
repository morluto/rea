/** Extract the text payload used by packaged MCP smoke assertions. */
export const mcpText = (result) => {
  const value = result.content?.find((item) => item.type === "text")?.text;
  if (typeof value !== "string") throw new Error("MCP result omitted text");
  return value;
};

/** Verify packaged prompt discovery and rendering through the public client. */
export const verifyPackagedPromptCatalog = async (
  client,
  options,
  expectedNames,
) => {
  const prompts = await client.listPrompts(undefined, options);
  if (
    JSON.stringify(prompts.prompts.map(({ name }) => name)) !==
    JSON.stringify(expectedNames)
  )
    throw new Error("packaged MCP prompt inventory diverged from contracts");
  const guided = await client.getPrompt(
    {
      name: "investigate_feature",
      arguments: { feature: "fixture behavior" },
    },
    options,
  );
  const guidedText = guided.messages.find(
    ({ content }) => content.type === "text",
  )?.content;
  if (
    guidedText?.type !== "text" ||
    !guidedText.text.includes("`trace_feature`") ||
    !guidedText.text.includes("Observations") ||
    !guidedText.text.includes("Unknowns")
  )
    throw new Error("packaged MCP guided prompt rendering failed");
};

/** Verify live completion through the installed stdio MCP artifact. */
export const verifyPackagedPromptCompletion = async (client, options) => {
  const result = await client.complete(
    {
      ref: { type: "ref/prompt", name: "investigate_feature" },
      argument: { name: "document", value: "fix" },
    },
    options,
  );
  if (
    JSON.stringify(result.completion.values) !== JSON.stringify(["fixture"]) ||
    result.completion.total !== 1 ||
    result.completion.hasMore !== false
  )
    throw new Error("packaged MCP prompt completion failed");
};
