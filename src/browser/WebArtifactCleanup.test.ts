import { expect, it } from "vitest";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import { ArtifactResourceScope } from "../resources/ArtifactResourceScope.js";
import { LocalWebScriptArtifacts } from "./assets/LocalWebScriptArtifacts.js";
import { LocalWebSourceLocationArtifacts } from "./assets/WebSourceLocationArtifacts.js";
import { LocalWebModuleArtifacts } from "./modules/WebModuleArtifacts.js";

it("reports a refusal from the shared script and map scope once", async () => {
  const resources = new ArtifactResourceScope();
  const refusal = new Error("shared scope close refused");
  let attempts = 0;
  resources.addCloseHook(async () => {
    if (++attempts === 1) throw refusal;
  });
  const scripts = new LocalWebScriptArtifacts(
    "trace_web_module_imports",
    resources,
  );
  const artifacts = new LocalWebModuleArtifacts(scripts, resources);
  const failure = await artifacts.close().catch((cause: unknown) => cause);
  expect(failure).toMatchObject({
    operation: "trace_web_module_imports",
    cause: refusal,
    cleanupResources: ["web module artifacts"],
    diagnostics: {
      failures: [
        { message: refusal.message, resource: ["web module artifacts"] },
      ],
    },
  });
  await artifacts.close();
  expect(failure).toMatchObject({
    cleanupIncomplete: false,
    cleanupResources: [],
  });
  expect(attempts).toBe(2);
});

it("reports independent untyped close refusals with their owner labels", async () => {
  const mapScope = new ArtifactResourceScope();
  const scriptScope = new ArtifactResourceScope();
  const mapFailure = new Error("map close refused");
  const scriptFailure = new Error("script close refused");
  let denied = true;
  mapScope.addCloseHook(async () => {
    if (denied) throw mapFailure;
  });
  scriptScope.addCloseHook(async () => {
    if (denied) throw scriptFailure;
  });
  const scripts = new LocalWebScriptArtifacts(
    "trace_web_source_location",
    scriptScope,
  );
  const artifacts = new LocalWebSourceLocationArtifacts(scripts, mapScope);
  const failure = await artifacts.close().catch((cause: unknown) => cause);
  expect(failure).toMatchObject({
    operation: "trace_web_source_location",
    cleanupResources: ["web source-location artifacts", "web scripts"],
    cause: { errors: [mapFailure, scriptFailure] },
    diagnostics: {
      failures: [
        {
          message: mapFailure.message,
          resource: ["web source-location artifacts"],
        },
        { message: scriptFailure.message, resource: ["web scripts"] },
      ],
    },
  });
  denied = false;
  await artifacts.close();
  expect(failure).toMatchObject({
    cleanupIncomplete: false,
    cleanupResources: [],
  });
});

it.each([
  ["trace_web_module_imports", LocalWebModuleArtifacts, "map", "script"],
  [
    "trace_web_source_location",
    LocalWebSourceLocationArtifacts,
    "script",
    "map",
  ],
] as const)(
  "resolves exact child errors and retries only unresolved %s owners",
  async (operation, Artifacts, released, retained) => {
    const mapScope = new ArtifactResourceScope();
    const scriptScope = new ArtifactResourceScope();
    const scripts = new LocalWebScriptArtifacts(operation, scriptScope);
    const failures = {
      map: new ProviderCleanupError("fixture", ["selected-map-handle"], {}),
      script: new ProviderCleanupError(
        "fixture",
        ["captured-script-handle"],
        {},
      ),
    };
    const labels = {
      map: "selected-map-handle",
      script: "captured-script-handle",
    };
    const refused = new Set(["map", "script"]);
    const attempts = { map: 0, script: 0 };
    for (const [owner, scope] of [
      ["map", mapScope],
      ["script", scriptScope],
    ] as const) {
      scope.addCloseHook(async () => {
        attempts[owner]++;
        if (refused.has(owner)) throw failures[owner];
      });
    }
    const artifacts = new Artifacts(scripts, mapScope);
    try {
      const first = await artifacts.close().catch((cause: unknown) => cause);
      expect(first).toMatchObject({
        operation,
        cleanupIncomplete: true,
        cleanupResources: [labels.map, labels.script],
      });

      refused.delete(released);
      const second = await artifacts.close().catch((cause: unknown) => cause);
      expect(failures[released].cleanupIncomplete).toBe(false);
      expect(failures[retained]).toMatchObject({
        cleanupIncomplete: true,
        cleanupResources: [labels[retained]],
      });
      for (const error of [first, second]) {
        expect(error).toMatchObject({
          cleanupIncomplete: true,
          cleanupResources: [labels[retained]],
        });
      }

      refused.clear();
      await artifacts.close();
      expect(failures[retained].cleanupIncomplete).toBe(false);
      for (const error of [first, second]) {
        expect(error).toMatchObject({
          cleanupIncomplete: false,
          cleanupResources: [],
        });
      }
      await artifacts.close();
      expect(attempts).toEqual({ [released]: 2, [retained]: 3 });
    } finally {
      refused.clear();
      await artifacts.close();
    }
  },
);
