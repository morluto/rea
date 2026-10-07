import { expect, it } from "vitest";

import { auxiliaryAnalysisProviderDeclarations } from "../../../src/composition/auxiliaryAnalysisProviders.js";
import { LazyAnalysisProvider } from "../../../src/application/binary/LazyAnalysisProvider.js";
import { parseBinaryTarget } from "../../../src/application/BinaryTargetResolver.js";
import { GENERATED_AUXILIARY_PROVIDERS } from "../../../src/generatedMcpToolCatalog.js";

it.each(["darwin", "linux", "win32"] as const)(
  "preserves canonical auxiliary metadata and host facts on %s",
  async (platform) => {
    const declarations = auxiliaryAnalysisProviderDeclarations(platform);
    expect(declarations.map(({ identity }) => identity)).toEqual(
      GENERATED_AUXILIARY_PROVIDERS.map(({ identity }) => identity),
    );
    const operations = new Set<string>();
    for (const declaration of declarations) {
      const canonical = GENERATED_AUXILIARY_PROVIDERS.find(
        ({ identity }) => identity.id === declaration.identity.id,
      );
      if (canonical === undefined)
        throw new Error("Missing canonical provider");
      const expected = canonical.capabilities.map((capability) => {
        if (platform === "darwin") return capability;
        if (capability.provider.id === "native-macos")
          return {
            ...capability,
            available: false,
            availabilityCode: "unsupported_host",
            reason: "Native macOS utilities require macOS.",
          };
        if (capability.operation === "inspect_asset_catalog")
          return {
            ...capability,
            available: false,
            availabilityCode: "unsupported_host",
            reason: "Apple asset catalogs require macOS assetutil.",
          };
        return capability;
      });
      expect(declaration.capabilities).toEqual(expected);
      const first = await declaration.load();
      const second = await declaration.load();
      expect(first).not.toBe(second);
      expect(first.identity()).toEqual(declaration.identity);
      expect(first.capabilities()).toEqual(declaration.capabilities);
      expect(second.capabilities()).toEqual(declaration.capabilities);
      for (const capability of declaration.capabilities) {
        expect(operations.has(capability.operation)).toBe(false);
        operations.add(capability.operation);
        expect(Object.isFrozen(capability)).toBe(true);
        expect(Object.isFrozen(capability.effects)).toBe(true);
        expect(Object.isFrozen(capability.limitations)).toBe(true);
      }
    }
    expect(operations.has("inspect_native_dispatch_metadata")).toBe(true);
  },
);

it("keeps declaration discovery and client creation lazy and independently owned", async () => {
  const target = await parseBinaryTarget(process.execPath);
  if (!target.ok) throw target.error;
  for (const declaration of auxiliaryAnalysisProviderDeclarations()) {
    let loads = 0;
    const provider = new LazyAnalysisProvider({
      ...declaration,
      load: async () => {
        loads += 1;
        return declaration.load();
      },
    });
    expect(provider.identity()).toEqual(declaration.identity);
    expect(provider.capabilities()).toEqual(declaration.capabilities);
    const client = provider.createClient(target.value);
    const unusedClient = provider.createClient(target.value);
    await unusedClient.close();
    expect(loads).toBe(0);
    try {
      expect(await client.execute("health", {})).toMatchObject({
        ok: true,
        value: { provider: declaration.identity },
      });
      expect(loads).toBe(1);
      expect(await client.execute("health", {})).toMatchObject({ ok: true });
      expect(loads).toBe(1);
    } finally {
      await client.close();
    }
  }
});
