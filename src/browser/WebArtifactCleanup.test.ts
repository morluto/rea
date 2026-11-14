import { expect, it, vi } from "vitest";
import { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import { LocalWebScriptArtifacts } from "./assets/LocalWebScriptArtifacts.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import { WebArtifactCleanup } from "./WebArtifactCleanup.js";
import { LocalWebModuleArtifacts } from "./modules/WebModuleArtifacts.js";
import { LocalWebSourceLocationArtifacts } from "./assets/WebSourceLocationArtifacts.js";

it("closes a shared script/resource scope once", async () => {
  const resources = new ArtifactResourceScope();
  const close = vi.spyOn(resources, "close").mockResolvedValue();
  const scripts = new LocalWebScriptArtifacts(
    "trace_web_module_imports",
    resources,
  );

  await new WebArtifactCleanup(
    "web-module-artifacts",
    resources,
    scripts,
  ).close();

  expect(close).toHaveBeenCalledTimes(1);
});

it.each([
  ["web-module-artifacts", "trace_web_module_imports", "web module artifacts"],
  [
    "web-source-location-artifacts",
    "trace_web_source_location",
    "web source-location artifacts",
  ],
] as const)(
  "attempts both cleanup owners and retries them for %s",
  async (owner, operation, resource) => {
    const resources = new ArtifactResourceScope();
    let resourceCloseCalls = 0;
    resources.addCloseHook(async () => {
      resourceCloseCalls++;
      if (resourceCloseCalls === 1)
        throw new Error("artifact close refused once");
    });
    const scripts = new LocalWebScriptArtifacts(
      "trace_web_module_imports",
      new ArtifactResourceScope(),
    );
    let scriptCloseCalls = 0;
    vi.spyOn(scripts, "close").mockImplementation(async () => {
      scriptCloseCalls++;
      if (scriptCloseCalls === 1) throw new Error("script close refused once");
    });

    const cleanup = new WebArtifactCleanup(owner, resources, scripts);
    await expect(cleanup.close()).rejects.toMatchObject({
      operation,
      cleanupResources: [resource, "web scripts"],
      diagnostics: {
        failures: [
          {
            message: "artifact close refused once",
            resource: [resource],
          },
          {
            message: "script close refused once",
            resource: ["web scripts"],
          },
        ],
      },
    });
    expect(resourceCloseCalls).toBe(1);
    expect(scriptCloseCalls).toBe(1);

    await cleanup.close();
    expect(resourceCloseCalls).toBe(2);
    expect(scriptCloseCalls).toBe(2);
  },
);

it.each(["resources", "scripts"] as const)(
  "retries only unresolved %s and resolves prior aggregate errors",
  async (failed) => {
    const resources = new ArtifactResourceScope();
    const scripts = new LocalWebScriptArtifacts(
      "trace_web_module_imports",
      new ArtifactResourceScope(),
    );
    const resourceClose = vi.spyOn(resources, "close").mockResolvedValue();
    const scriptClose = vi.spyOn(scripts, "close").mockResolvedValue();
    const denied = failed === "resources" ? resourceClose : scriptClose;
    denied.mockRejectedValueOnce(new Error("controlled close refusal"));
    const cleanup = new WebArtifactCleanup(
      "web-module-artifacts",
      resources,
      scripts,
    );
    const first = await cleanup.close().catch((cause: unknown) => cause);
    expect(first).toMatchObject({
      cleanupIncomplete: true,
      cleanupResources: [
        failed === "resources" ? "web module artifacts" : "web scripts",
      ],
    });
    await cleanup.close();
    expect(first).toMatchObject({
      cleanupIncomplete: false,
      cleanupResources: [],
    });
    expect(resourceClose).toHaveBeenCalledTimes(failed === "resources" ? 2 : 1);
    expect(scriptClose).toHaveBeenCalledTimes(failed === "scripts" ? 2 : 1);
    await cleanup.close();
    expect(denied).toHaveBeenCalledTimes(2);
  },
);

it.each([
  ["web module", LocalWebModuleArtifacts],
  ["web source location", LocalWebSourceLocationArtifacts],
] as const)(
  "resolves exact child errors through %s artifact cleanup retries",
  async (_name, Artifacts) => {
    const resources = new ArtifactResourceScope();
    const scriptResources = new ArtifactResourceScope();
    const scripts = new LocalWebScriptArtifacts(
      "trace_web_module_imports",
      scriptResources,
    );
    const resourceFailure = new ProviderCleanupError(
      "fixture",
      ["selected-map-handle"],
      {},
    );
    const scriptFailure = new ProviderCleanupError(
      "fixture",
      ["captured-script-handle"],
      {},
    );
    let resourceDenied = true;
    let scriptDenied = true;
    let resourceCloses = 0;
    let scriptCloses = 0;
    resources.addCloseHook(async () => {
      resourceCloses++;
      if (resourceDenied) throw resourceFailure;
    });
    scriptResources.addCloseHook(async () => {
      scriptCloses++;
      if (scriptDenied) throw scriptFailure;
    });
    const artifacts = new Artifacts(scripts, resources);
    try {
      const first = await artifacts.close().catch((cause: unknown) => cause);
      expect(first).toMatchObject({
        cleanupIncomplete: true,
        cleanupResources: ["selected-map-handle", "captured-script-handle"],
      });
      expect(resourceFailure.cleanupResources).toEqual(["selected-map-handle"]);
      expect(scriptFailure.cleanupResources).toEqual([
        "captured-script-handle",
      ]);
      resourceDenied = false;
      const second = await artifacts.close().catch((cause: unknown) => cause);
      expect(resourceFailure.cleanupIncomplete).toBe(false);
      expect(scriptFailure.cleanupIncomplete).toBe(true);
      expect(scriptFailure.cleanupResources).toEqual([
        "captured-script-handle",
      ]);
      expect(first).toMatchObject({
        cleanupIncomplete: true,
        cleanupResources: ["captured-script-handle"],
      });
      scriptDenied = false;
      await artifacts.close();
      expect(scriptFailure.cleanupIncomplete).toBe(false);
      expect(first).toMatchObject({
        cleanupIncomplete: false,
        cleanupResources: [],
      });
      expect(second).toMatchObject({
        cleanupIncomplete: false,
        cleanupResources: [],
      });
      await artifacts.close();
      expect(resourceCloses).toBe(2);
      expect(scriptCloses).toBe(3);
    } finally {
      resourceDenied = false;
      scriptDenied = false;
      await artifacts.close();
    }
  },
);
