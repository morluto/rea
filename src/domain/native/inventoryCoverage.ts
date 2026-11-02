import { z } from "zod";

/**
 * Whether a provider inventory discovered every procedure, string or name in
 * the file. No provider establishes that today, so it is always unknown.
 */
export const inventoryDiscoveryCoverageSchema = z.literal("unknown");

/**
 * What overview counts measure: every row the bound provider's procedure and
 * string inventories returned, not discovery of the file. The tool
 * description carries the agent-facing explanation once.
 */
export const overviewInventoryCoverageSchema = z.strictObject({
  scope: z.literal("provider_inventory"),
  discovery_coverage: inventoryDiscoveryCoverageSchema,
});

/**
 * Label an overview from any producer, including a replayed snapshot saved
 * before this record existed: the counts' meaning does not depend on who
 * produced them.
 */
export const withOverviewInventoryCoverage = <Value>(overview: Value): Value =>
  typeof overview === "object" && overview !== null && !Array.isArray(overview)
    ? {
        ...overview,
        inventory_coverage: {
          scope: "provider_inventory",
          discovery_coverage: "unknown",
        } satisfies z.output<typeof overviewInventoryCoverageSchema>,
      }
    : overview;
