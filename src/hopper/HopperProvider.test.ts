import { describe, expect, it } from "vitest";

import { parseConfig } from "../config.js";
import { silentLogger } from "../logger.js";
import { HopperProvider } from "./HopperProvider.js";

describe("Hopper provider capabilities", () => {
  it("publishes deterministic descriptors and resists caller mutation", () => {
    const config = parseConfig({});
    expect(config.ok).toBe(true);
    if (!config.ok) return;
    const provider = new HopperProvider(config.value, silentLogger);
    const capabilities = provider.capabilities();
    const published = structuredClone(capabilities);
    expect(capabilities).toHaveLength(37);
    expect(new Set(capabilities.map(({ operation }) => operation)).size).toBe(
      capabilities.length,
    );
    for (const descriptor of capabilities) {
      expect(descriptor.provider).toEqual(provider.identity());
      expect(descriptor).toMatchObject({
        inputContractVersion: 1,
        outputContractVersion: 1,
        available: true,
        reason: null,
      });
    }
    expect(
      capabilities.find(({ operation }) => operation === "list_procedures"),
    ).toMatchObject({ pagination: "offset" });
    expect(
      capabilities.find(({ operation }) => operation === "set_comment"),
    ).toMatchObject({
      effects: { mutatesArtifact: true, mayWriteFilesystem: true },
    });
    const first = capabilities[0];
    if (first === undefined) throw new Error("Hopper capabilities are empty");
    Reflect.set(capabilities, 0, { ...first, available: false });
    Reflect.set(first, "available", false);
    Reflect.set(first.effects, "mutatesArtifact", true);
    Reflect.set(first.limits, "maxResults", 0);
    Reflect.set(first.limitations, 0, "forged limitation");

    expect(provider.capabilities()).toEqual(published);
  });
});
