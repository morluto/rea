/** Recovery for an MCP server that could not finish starting; startup is not retried. */
export const SERVER_START_FAILED =
  "Do not repeat this startup. Tell the user REA could not start and ask them to restart the MCP client, then run `rea doctor`.";
