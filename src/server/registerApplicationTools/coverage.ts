import type { McpServer } from "@modelcontextprotocol/server";

import {
  commitReconstructionCoverage,
  queryReconstructionCoverage,
} from "../../application/ReconstructionCoverageService.js";
import { readReconstructionCoverageWorkspace } from "../../application/ReconstructionCoverageWorkspaceStore.js";
import {
  authorizeFileReadWithDeferredWrite,
  authorizeRootPermission,
} from "../../application/DeferredFileAuthorization.js";
import { applicationToolContract } from "../../contracts/applicationToolContracts.js";
import {
  reconstructionCoverageCommitInputSchema,
  reconstructionCoverageQueryInputSchema,
} from "../../application/ReconstructionCoverageService.js";
import { reconstructionClosureResultSchema } from "../../domain/reconstructionCoverage.js";
import {
  AnalysisCapabilityUnavailableError,
  EvidenceIntegrityError,
} from "../../domain/errors.js";
import { err } from "../../domain/result.js";
import { logToolExecution } from "../toolLogging.js";
import { toCallToolResult } from "../toolResult.js";
import { toolRegistrationOptions } from "../toolRegistrationOptions.js";
import { safeParseToolInput } from "../toolInputValidation.js";
import { coverageWorkspaceUri } from "./helpers.js";
import type { ApplicationToolRegistration } from "./types.js";

const commitContract = applicationToolContract(
  "commit_reconstruction_coverage",
);
const queryContract = applicationToolContract("query_reconstruction_coverage");

/** Register reconstruction coverage commit and query tools. */
export const registerCoverageTools = (
  server: McpServer,
  options: ApplicationToolRegistration,
): void => {
  registerCommitTool(server, options);
  registerQueryTool(server, options);
};

const registerCommitTool = (
  server: McpServer,
  options: ApplicationToolRegistration,
): void => {
  server.registerTool(
    commitContract.name,
    toolRegistrationOptions(commitContract),
    async (input, context) => {
      const parsed = safeParseToolInput(
        reconstructionCoverageCommitInputSchema,
        input,
        commitContract.name,
      );
      if (!parsed.ok) return toCallToolResult(parsed, commitContract);
      if (options.permissionAuthority === undefined)
        return toCallToolResult(
          err(
            new AnalysisCapabilityUnavailableError(
              "rea-reconstruction-coverage",
              commitContract.name,
              "workspace permission policy is not configured",
            ),
          ),
          commitContract,
        );
      const authorization = await authorizeFileReadWithDeferredWrite(
        options.permissionAuthority,
        {
          path: parsed.value.workspace_path,
          readCapability: "investigation_workspace_read",
          writeCapability: "investigation_workspace_write",
          operation: commitContract.name,
        },
      );
      if (!authorization.ok)
        return toCallToolResult(authorization, commitContract);
      const write = await authorization.value.authorizeWrite();
      if (!write.ok) return toCallToolResult(write, commitContract);
      const result = await logToolExecution(
        options.logger,
        commitContract.name,
        () =>
          commitReconstructionCoverage(
            parsed.value,
            options.evidenceFilePolicy,
            { signal: context.mcpReq.signal },
          ),
      );
      if (!result.ok) return toCallToolResult(result, commitContract);
      options.retainCoverageWorkspace?.(parsed.value.workspace);
      return toCallToolResult(result, commitContract, {
        resourceLinks:
          options.retainCoverageWorkspace === undefined
            ? []
            : [
                {
                  uri: coverageWorkspaceUri(parsed.value.workspace),
                  name: parsed.value.workspace.workspace_id,
                  description:
                    "Session-retained reconstruction coverage workspace revision",
                },
              ],
      });
    },
  );
};

const registerQueryTool = (
  server: McpServer,
  options: ApplicationToolRegistration,
): void => {
  server.registerTool(
    queryContract.name,
    toolRegistrationOptions(queryContract),
    async (input, context) => {
      const parsed = safeParseToolInput(
        reconstructionCoverageQueryInputSchema,
        input,
        queryContract.name,
      );
      if (!parsed.ok) return toCallToolResult(parsed, queryContract);
      if (options.permissionAuthority === undefined)
        return toCallToolResult(
          err(
            new AnalysisCapabilityUnavailableError(
              "rea-reconstruction-coverage",
              queryContract.name,
              "workspace permission policy is not configured",
            ),
          ),
          queryContract,
        );
      const authorized = await authorizeRootPermission(
        options.permissionAuthority,
        {
          capability: "investigation_workspace_read",
          roots: [parsed.value.workspace_path],
          access: "read",
          operation: queryContract.name,
        },
      );
      if (!authorized.ok) return toCallToolResult(authorized, queryContract);
      const result = await logToolExecution(
        options.logger,
        queryContract.name,
        () =>
          queryReconstructionCoverage(
            parsed.value,
            options.evidenceFilePolicy,
            Date.now(),
            { signal: context.mcpReq.signal },
          ),
      );
      if (result.ok && options.retainCoverageWorkspace !== undefined) {
        const closure = reconstructionClosureResultSchema.parse(result.value);
        const loaded = await readReconstructionCoverageWorkspace(
          parsed.value.workspace_path,
          options.evidenceFilePolicy,
        );
        if (!loaded.ok) return toCallToolResult(loaded, queryContract);
        if (
          loaded.value === null ||
          loaded.value.revision_sha256 !== closure.workspace_revision_sha256
        )
          return toCallToolResult(
            err(
              new EvidenceIntegrityError(
                "workspace changed while its closure was being retained",
              ),
            ),
            queryContract,
          );
        options.retainCoverageWorkspace(loaded.value);
      }
      return toCallToolResult(result, queryContract);
    },
  );
};
