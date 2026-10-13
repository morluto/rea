/**
 * Supported MCP startup deadlines and regression budgets.
 *
 * The Codex timeout is caller-facing configuration. The smaller phase budgets
 * preserve operational headroom, while the doctor deadline covers additional
 * inventory requests after initialization.
 */
export const MCP_STARTUP_POLICY = {
  codexStartupTimeoutSeconds: 30,
  kimiStartupTimeoutMs: 30_000,
  kimiToolTimeoutMs: 120_000,
  initializeBudgetMs: 15_000,
  toolsListBudgetMs: 5_000,
  firstCatalogBudgetMs: 20_000,
  doctorDeadlineMs: 30_000,
} as const;
