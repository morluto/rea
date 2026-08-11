import { describe, expect, it } from "vitest";

import { parseConfig } from "../config.js";
import { silentLogger } from "../logger.js";
import { GHIDRA_FUNCTION_OPERATIONS } from "./GhidraFunctionValues.js";
import { GHIDRA_INVENTORY_OPERATIONS } from "./GhidraInventoryValues.js";
import { GhidraProvider } from "./GhidraProvider.js";

describe("Ghidra provider capabilities", () => {
  it("publishes only admitted read-only operations and resists caller mutation", () => {
    const config = parseConfig({});
    expect(config.ok).toBe(true);
    if (!config.ok) return;
    const provider = new GhidraProvider(config.value, silentLogger, {
      readText: () => undefined,
      executable: () => false,
      probeJava: () => undefined,
    });
    const capabilities = provider.capabilities();
    const published = structuredClone(capabilities);
    expect(capabilities.map(({ operation }) => operation).sort()).toEqual(
      [...GHIDRA_INVENTORY_OPERATIONS, ...GHIDRA_FUNCTION_OPERATIONS].sort(),
    );
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
    }
    const first = capabilities[0];
    if (first === undefined) throw new Error("Ghidra capabilities are empty");
    Reflect.set(capabilities, 0, { ...first, available: false });
    Reflect.set(first, "available", false);
    Reflect.set(first.effects, "mutatesArtifact", true);
    Reflect.set(first.limits, "maxResults", 0);
    Reflect.set(first.limitations, 0, "forged limitation");

    expect(provider.capabilities()).toEqual(published);
  });
});
