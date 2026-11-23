import {
  PROMPT_CONTRACTS,
  guidedPromptArgumentsSchema,
  guidedPromptInventory,
  renderGuidedPrompt,
  type PromptContract,
} from "../contracts/promptContracts.js";
import { AnalysisInputError } from "../domain/analysisErrorCore.js";
import {
  analysisInputErrorFromIssues,
  projectInputIssues,
} from "../domain/inputIssueProjection.js";
import { err, ok, type Result } from "../domain/result.js";
import {
  guidedWorkflowsInputSchema,
  type GuidedWorkflowsResult,
} from "../contracts/guidedWorkflowSchemas.js";

export const GUIDED_WORKFLOWS_OPERATION = "guided_workflows";

/** Validate and perform a provider-free list or render request. */
export const accessGuidedWorkflows = (
  input: unknown,
  options: {
    readonly contracts?: readonly PromptContract[];
    readonly listRemediation?: string;
  } = {},
): Result<GuidedWorkflowsResult, AnalysisInputError> => {
  const parsed = guidedWorkflowsInputSchema.safeParse(input);
  if (!parsed.success)
    return err(
      analysisInputErrorFromIssues(
        GUIDED_WORKFLOWS_OPERATION,
        parsed.error.issues,
        input,
      ),
    );

  const contracts = options.contracts ?? PROMPT_CONTRACTS;
  if (parsed.data.action === "list")
    return ok({ action: "list", workflows: guidedPromptInventory(contracts) });

  const listRemediation =
    options.listRemediation ??
    'Call `guided_workflows` with `{"action":"list"}` to see workflow identifiers and argument requirements in this connection.';
  const id = parsed.data.workflow_id;
  const contract = contracts.find(({ name }) => name === id);
  if (contract === undefined)
    return invalidWorkflowSelection(
      PROMPT_CONTRACTS.some(({ name }) => name === id)
        ? `Workflow '${id}' is not available in the selected tool-family scope.`
        : `Unknown workflow_id '${id}'.`,
      [{ path: ["workflow_id"], reason: "invalid_value" }],
      listRemediation,
    );

  const arguments_ = parsed.data.arguments ?? {};
  const validated = guidedPromptArgumentsSchema(contract).safeParse(arguments_);
  if (!validated.success) {
    const issues = projectInputIssues(
      validated.error.issues.map((issue) => ({
        ...issue,
        path: ["arguments", ...issue.path],
      })),
      input,
    );
    const missing = issues
      .filter(({ reason }) => reason === "missing_argument")
      .map(({ path }) => String(path.at(-1)));
    return invalidWorkflowSelection(
      missing.length === 0
        ? "The selected workflow does not accept the supplied arguments."
        : `Missing required arguments for ${id}: ${missing.join(", ")}.`,
      issues,
      listRemediation,
    );
  }

  return ok({
    action: "render",
    workflow_id: id,
    rendered_prompt: renderGuidedPrompt(
      contract,
      Object.fromEntries(
        Object.entries(validated.data).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      ),
    ),
  });
};

const invalidWorkflowSelection = (
  userMessage: string,
  additionalIssues: ConstructorParameters<typeof AnalysisInputError>[2],
  remediationAction: string,
): Result<never, AnalysisInputError> =>
  err(
    new AnalysisInputError(
      GUIDED_WORKFLOWS_OPERATION,
      {
        userMessage,
        conformsToInputContract: true,
        remediationAction,
      },
      additionalIssues,
    ),
  );
