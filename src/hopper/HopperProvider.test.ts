import { describe, expect, it } from "vitest";

import { parseConfig } from "../config.js";
import { silentLogger } from "../logger.js";
import { HopperProvider } from "./HopperProvider.js";

describe("Hopper provider capabilities", () => {
  it("publishes deterministic immutable capability descriptors", () => {
    const config = parseConfig({});
    expect(config.ok).toBe(true);
    if (!config.ok) return;
    const provider = new HopperProvider(config.value, silentLogger);
    const capabilities = provider.capabilities();
    expect(capabilities).toHaveLength(37);
    expect(new Set(capabilities.map(({ operation }) => operation)).size).toBe(
      capabilities.length,
    );
    expect(Object.isFrozen(capabilities)).toBe(true);
    for (const descriptor of capabilities) {
      expect(descriptor.provider).toEqual(provider.identity());
      expect(descriptor).toMatchObject({
        inputContractVersion: 1,
        outputContractVersion: 1,
        available: true,
        reason: null,
      });
      expect(Object.isFrozen(descriptor)).toBe(true);
      expect(Object.isFrozen(descriptor.effects)).toBe(true);
      expect(Object.isFrozen(descriptor.limits)).toBe(true);
      expect(Object.isFrozen(descriptor.limitations)).toBe(true);
    }
    expect(
      capabilities.find(({ operation }) => operation === "list_procedures"),
    ).toMatchObject({ pagination: "offset" });
    expect(
      capabilities.find(({ operation }) => operation === "set_comment"),
    ).toMatchObject({
      effects: { mutatesArtifact: true, mayWriteFilesystem: true },
    });
  });
});
