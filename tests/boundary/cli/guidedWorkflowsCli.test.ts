import { expect } from "vitest";
import { guidedWorkflowsOutputSchema } from "../../../src/contracts/guidedWorkflowSchemas.js";
import { cliTest as it, type TestCli } from "../../support/cli/cliFixture.js";

const run = (cli: TestCli, arguments_: readonly string[]) =>
  cli.run({
    arguments: ["guided-workflows", ...arguments_, "--json"],
    environment: { REA_LOG_LEVEL: "silent" },
  });

const render = (cli: TestCli, workflowId: string, json?: string) =>
  run(cli, [
    "--action",
    "render",
    "--workflow-id",
    workflowId,
    ...(json === undefined ? [] : ["--arguments-json", json]),
  ]);

it("renders a workflow selected from the default CLI inventory", async ({
  cli,
}) => {
  const listed = await run(cli, []);
  expect(listed).toMatchObject({ exitCode: 0, stderr: "" });
  const inventory = guidedWorkflowsOutputSchema.parse(listed.json);
  if (inventory.action !== "list")
    throw new Error("Expected the workflow inventory");
  const feature = inventory.workflows.find(
    ({ workflow_id }) => workflow_id === "investigate_feature",
  );
  expect(feature?.arguments).toContainEqual(
    expect.objectContaining({
      name: "feature",
      required: true,
      description: expect.any(String),
    }),
  );
  if (feature === undefined) throw new Error("Expected the feature workflow");

  const context = { feature: 'search "offline"\nRetain the selected string' };
  const result = await render(
    cli,
    feature.workflow_id,
    JSON.stringify(context),
  );
  expect(result).toMatchObject({
    exitCode: 0,
    stderr: "",
    json: {
      action: "render",
      workflow_id: feature.workflow_id,
      rendered_prompt: expect.stringContaining(JSON.stringify(context)),
    },
  });
});

it("names the CLI option when argument JSON is malformed", async ({ cli }) => {
  const result = await render(cli, "investigate_feature", '{"feature":');
  expect(result).toMatchObject({ exitCode: 1, stderr: "" });
  expect(result.stdout).toContain(
    "--arguments-json must contain a valid JSON object",
  );
});

it.for([
  {
    name: "missing required feature",
    id: "investigate_feature",
    json: "{}",
    issue: { path: ["argumentsJson", "feature"], reason: "missing_argument" },
    message: /Missing required arguments.*feature/u,
  },
  {
    name: "non-string feature",
    id: "investigate_feature",
    json: '{"feature":1}',
    issue: { path: ["argumentsJson", "feature"], reason: "invalid_type" },
  },
  {
    name: "unknown workflow selector",
    id: "not_a_workflow",
    issue: { path: ["workflowId"], reason: "invalid_value" },
    message: /Unknown workflow_id.*not_a_workflow/u,
  },
])(
  "projects $name with the relevant CLI recovery",
  async ({ id, json, issue, message }, { cli }) => {
    const result = await render(cli, id, json);
    expect(result).toMatchObject({
      exitCode: 1,
      stderr: "",
      json: {
        code: "invalid_request",
        details: { issues: [issue] },
      },
    });
    if (message === undefined) {
      expect(result.json).toMatchObject({
        recovery: {
          kind: "inspect_input_contract",
          operation: "guided_workflows",
        },
      });
    } else {
      expect(result.json).toMatchObject({
        message: expect.stringMatching(message),
        remediation: {
          action: expect.stringContaining("rea guided-workflows"),
        },
      });
      expect(result.json).not.toHaveProperty("recovery");
    }
  },
);

it("refuses a render-only option when --action selects the list branch", async ({
  cli,
}) => {
  for (const action of [[], ["--action", "list"]]) {
    const result = await run(cli, [
      ...action,
      "--workflow-id",
      "investigate_feature",
    ]);
    expect(result).toMatchObject({
      exitCode: 1,
      stderr: "",
      json: { code: "invalid_request" },
    });
  }
});

it("refuses an --action that selects no input branch", async ({ cli }) => {
  const result = await run(cli, ["--action", "delete"]);
  expect(result).toMatchObject({ exitCode: 1, stderr: "" });
  expect(result.stdout).toContain("action");
});
