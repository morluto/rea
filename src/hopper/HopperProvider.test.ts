import { describe, expect, it } from "vitest";

import { parseConfig } from "../config.js";
import { silentLogger } from "../logger.js";
import {
  HopperProvider,
  HOPPER_PROVIDER_TOOL_CONTRACTS,
} from "./HopperProvider.js";

describe("Hopper provider capabilities", () => {
  it("declines DOS MZ targets with a provider-specific support reason", () => {
    const config = parseConfig({});
    if (!config.ok) throw new Error("expected valid configuration");
    const provider = new HopperProvider(config.value, silentLogger);
    expect(
      provider.inspectTargetSupport({
        path: "/tmp/legacy.exe",
        sha256: "a".repeat(64),
        kind: "executable",
        format: "dos-mz",
        architecture: "x86",
        availableArchitectures: ["x86"],
      }),
    ).toMatchObject({
      status: "unsupported",
      code: "target_format_unsupported",
      reason: expect.stringContaining("Ghidra"),
    });
  });

  it("publishes deterministic descriptors and resists caller mutation", () => {
    const config = parseConfig({});
    expect(config.ok).toBe(true);
    if (!config.ok) throw new Error("expected valid configuration");
    const provider = new HopperProvider(config.value, silentLogger);
    const capabilities = provider.capabilities();
    const published = structuredClone(capabilities);
    expect(capabilities.map(({ operation }) => operation)).toEqual(
      HOPPER_PROVIDER_TOOL_CONTRACTS.map(({ name }) => name),
    );
    expect(new Set(capabilities.map(({ operation }) => operation)).size).toBe(
      capabilities.length,
    );
    for (const descriptor of capabilities) {
      expect(descriptor.provider).toEqual(provider.identity());
      expect(descriptor).toMatchObject({
        available: true,
        reason: null,
      });
    }
    expect(
      capabilities.find(({ operation }) => operation === "list_procedures"),
    ).toMatchObject({ available: true });
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
    Reflect.set(first.limitations, 0, "forged limitation");

    expect(provider.capabilities()).toEqual(published);
  });
});
