import { expect, vi } from "vitest";
import { observed } from "../../tests/fixtures/analysisExecution.js";
import { mcpTest as it } from "../../tests/support/mcp/mcpFixture.js";
import { PROMPT_CONTRACTS } from "../contracts/promptContracts.js";
import { silentLogger } from "../logger.js";
import { EvidenceMcpServer } from "./EvidenceMcpServer.js";
import { registerServiceTools } from "./serviceToolBindings.js";
import { registerGuidedPrompts } from "./registerPrompts.js";
import { ToolResultDelivery } from "./ToolResultDelivery.js";

it("lists and renders without acquiring analysis while native completion can query the provider", async ({
  mcp,
}) => {
  const server = new EvidenceMcpServer(
    { name: "guided-workflow-fixture", version: "1" },
    { capabilities: { completions: {} } },
    undefined,
    new ToolResultDelivery(1024 * 1024),
  );
  const execute = vi.fn(async () => observed(["Notes"]));
  registerGuidedPrompts(server, { execute });
  registerServiceTools(
    server,
    { guidedWorkflows: PROMPT_CONTRACTS },
    { logger: silentLogger },
  );
  const client = await mcp.connect(server);
  const listed = await client.callTool({
    name: "guided_workflows",
    arguments: { action: "list" },
  });
  expect(listed.structuredContent).toMatchObject({ action: "list" });
  const rendered = await client.callTool({
    name: "guided_workflows",
    arguments: {
      action: "render",
      workflow_id: "investigate_feature",
      arguments: { feature: "offline search" },
    },
  });
  expect(rendered.structuredContent).toMatchObject({ action: "render" });
  const refused = await client.callTool({
    name: "guided_workflows",
    arguments: { action: "list", extra: true },
  });
  expect(refused.isError).toBe(true);
  expect(execute).not.toHaveBeenCalled();

  const reply = await client.complete({
    ref: { type: "ref/prompt", name: "investigate_feature" },
    argument: { name: "document", value: "No" },
  });
  expect(reply.completion.values).toEqual(["Notes"]);
  expect(execute).toHaveBeenCalledTimes(1);
});
