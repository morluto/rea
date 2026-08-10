import { describe, expect, it } from "vitest";

import { parseConfig } from "../config.js";
import { silentLogger } from "../logger.js";
import { GHIDRA_FUNCTION_OPERATIONS } from "./GhidraFunctionValues.js";
import { GHIDRA_INVENTORY_OPERATIONS } from "./GhidraInventoryValues.js";
import { GhidraProvider } from "./GhidraProvider.js";

describe("Ghidra provider capabilities", () => {
  it("publishes only admitted immutable read-only operations", () => {
    const config = parseConfig({});
    expect(config.ok).toBe(true);
    if (!config.ok) return;
    const provider = new GhidraProvider(config.value, silentLogger, {
      readText: () => undefined,
      executable: () => false,
      probeJava: () => undefined,
    });
    const capabilities = provider.capabilities();
    expect(capabilities.map(({ operation }) => operation).sort()).toEqual(
      [...GHIDRA_INVENTORY_OPERATIONS, ...GHIDRA_FUNCTION_OPERATIONS].sort(),
    );
    expect(Object.isFrozen(capabilities)).toBe(true);
    for (const descriptor of capabilities) {
      expect(descriptor).toMatchObject({
        available: true,
        reason: null,
        effects: {
          mutatesArtifact: false,
          mayShowUi: false,
          mayAccessNetwork: false,
          changesPermissions: false,
          requiresRoot: false,
        },
      });
      expect(Object.isFrozen(descriptor)).toBe(true);
      expect(Object.isFrozen(descriptor.effects)).toBe(true);
      expect(Object.isFrozen(descriptor.limits)).toBe(true);
      expect(Object.isFrozen(descriptor.limitations)).toBe(true);
    }
  });
});
