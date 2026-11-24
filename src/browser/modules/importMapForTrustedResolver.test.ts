import { expect, it } from "vitest";
import { importMapForTrustedResolver } from "./importMapForTrustedResolver.js";

const baseUrl = "https://app.test/maps/index.html";
const importer = "https://app.test/maps/scoped/main.js?build=2#entry";

it("removes importer integrity and serializes every other entry unchanged", () => {
  const dependencyIntegrity = {
    "./dep.js": "sha256-dep",
    "https://other.test/maps/scoped/main.js": "sha256-other-origin",
    "./scoped/other.js": "sha256-other-path",
    "http://[": "sha256-invalid-url",
    ["__proto__"]: "sha256-proto-dep",
  };
  const importerIntegrity = {
    [importer]: "sha256-exact",
    "./scoped/main.js?build=1#other": "sha256-relative",
    "/maps/scoped/main.js": "sha256-path",
  };
  const map = {
    imports: { dep: "./dep.js" },
    scopes: { "/scoped/": { dep: "./scoped.js" } },
    integrity: { ...dependencyIntegrity, ...importerIntegrity },
  };

  const original = JSON.stringify(map);
  const installed = importMapForTrustedResolver(map, importer, baseUrl);
  expect(JSON.parse(JSON.stringify(installed))).toStrictEqual({
    imports: map.imports,
    scopes: map.scopes,
    integrity: dependencyIntegrity,
  });
  expect(JSON.stringify(map)).toBe(original);
});

it("omits integrity only when removing the last entry", () => {
  const map = { imports: { dep: "./dep.js" } };
  const dependencyOnly = { ...map, integrity: { "./dep.js": "sha256-dep" } };
  expect(importMapForTrustedResolver(map, importer, baseUrl)).toEqual(map);
  expect(
    importMapForTrustedResolver(dependencyOnly, importer, baseUrl),
  ).toEqual(dependencyOnly);
  expect(
    importMapForTrustedResolver(
      {
        ...map,
        integrity: { "/maps/scoped/main.js": "sha256-importer" },
      },
      importer,
      baseUrl,
    ),
  ).toEqual(map);
});
