import { describe, expect, it } from "vitest";

import { toolAvailability } from "../contracts/toolOutputSchemaPrimitives.js";
import { buildCapabilityInventory } from "./CapabilityInventory.js";

describe("capability inventory contract", () => {
  it("produces valid availability and rejects contradictory states", () => {
    const inventory = buildCapabilityInventory(
      { open: false, capabilities: [] },
      {
        processCaptureEnabled: false,
        evidenceFileRoots: 0,
        investigationInputRoots: 0,
      },
    );
    const unavailable = inventory.find(({ available }) => !available);
    expect(unavailable).toBeDefined();
    expect(toolAvailability.safeParse(unavailable).success).toBe(true);
    expect(
      toolAvailability.safeParse({ ...unavailable, available: true }).success,
    ).toBe(false);
    expect(
      toolAvailability.safeParse({
        ...unavailable,
        available: false,
        reason: "available",
      }).success,
    ).toBe(false);
  });
});
