import type { ServerContext } from "@modelcontextprotocol/server";
import type { ProgressReporter } from "../application/ProgressReporter.js";
import {
  createProgressReporter,
  silentProgressReporter,
} from "../application/ProgressReporter.js";

export interface McpProgressContext {
  readonly mcpReq: Pick<ServerContext["mcpReq"], "_meta" | "notify">;
}

/** Adapt the request's negotiated MCP progress token to application progress. */
export const mcpProgressReporter = (
  context: McpProgressContext,
): ProgressReporter => {
  const token = context.mcpReq._meta?.progressToken;
  if (token === undefined) return silentProgressReporter;
  return createProgressReporter(
    async (update) => {
      try {
        await context.mcpReq.notify({
          method: "notifications/progress",
          params: {
            progressToken: token,
            progress: update.completed,
            ...(update.total === null ? {} : { total: update.total }),
            message: `${update.phase}: ${update.message}`,
          },
        });
      } catch {
        // Progress is observational; transport failure cannot change tool truth.
      }
    },
    { minimumIntervalMs: 100 },
  );
};
