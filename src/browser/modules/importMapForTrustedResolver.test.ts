import { describe, expect, it } from "vitest";
import { importMapForTrustedResolver } from "./importMapForTrustedResolver.js";

describe("importMapForTrustedResolver", () => {
  const baseUrl = "https://app.test/index.html";
  const importerUrl = "https://app.test/main.js";

  it("omits integrity that covers the selected importer URL", () => {
    const map = {
      imports: { dep: "/dep.js" },
      integrity: {
        "https://app.test/main.js": "sha256-importer",
        "https://app.test/dep.js": "sha256-dep",
      },
    };
    expect(importMapForTrustedResolver(map, importerUrl, baseUrl)).toEqual({
      imports: { dep: "/dep.js" },
      integrity: { "https://app.test/dep.js": "sha256-dep" },
    });
  });

  it("resolves relative integrity keys against the import-map base URL", () => {
    const map = {
      imports: { dep: "./dep.js" },
      integrity: {
        "./main.js": "sha256-importer",
        "./dep.js": "sha256-dep",
      },
    };
    expect(
      importMapForTrustedResolver(map, "https://app.test/main.js", baseUrl),
    ).toEqual({
      imports: { dep: "./dep.js" },
      integrity: { "./dep.js": "sha256-dep" },
    });
  });

  it("matches importer integrity across query and fragment differences", () => {
    const map = {
      imports: { dep: "/dep.js" },
      integrity: {
        "https://app.test/main.js": "sha256-importer",
        "https://app.test/dep.js": "sha256-dep",
      },
    };
    expect(
      importMapForTrustedResolver(
        map,
        "https://app.test/main.js?build=1#entry",
        baseUrl,
      ),
    ).toEqual({
      imports: { dep: "/dep.js" },
      integrity: { "https://app.test/dep.js": "sha256-dep" },
    });
  });

  it("drops an empty integrity member after removing the importer entry", () => {
    const map = {
      imports: { dep: "/dep.js" },
      integrity: { "https://app.test/main.js": "sha256-importer" },
    };
    expect(importMapForTrustedResolver(map, importerUrl, baseUrl)).toEqual({
      imports: { dep: "/dep.js" },
    });
  });

  it("preserves maps without integrity and dependency-only integrity", () => {
    const without = { imports: { dep: "/dep.js" } };
    expect(importMapForTrustedResolver(without, importerUrl, baseUrl)).toBe(
      without,
    );
    const dependencyOnly = {
      imports: { dep: "/dep.js" },
      integrity: { "https://app.test/dep.js": "sha256-dep" },
    };
    expect(
      importMapForTrustedResolver(dependencyOnly, importerUrl, baseUrl),
    ).toBe(dependencyOnly);
  });

  it("preserves a dependency integrity key named __proto__ without prototype pollution", () => {
    const integrity = Object.assign(Object.create(null), {
      "https://app.test/main.js": "sha256-importer",
      "https://app.test/dep.js": "sha256-dep",
    });
    integrity["__proto__"] = "sha256-proto-dep";
    const map = { imports: { dep: "/dep.js" }, integrity };
    const next = importMapForTrustedResolver(map, importerUrl, baseUrl);
    const nextIntegrity = next.integrity as { readonly [key: string]: string };
    expect(nextIntegrity["https://app.test/dep.js"]).toBe("sha256-dep");
    expect(
      Object.getOwnPropertyDescriptor(nextIntegrity, "__proto__")?.value,
    ).toBe("sha256-proto-dep");
    expect(Object.getPrototypeOf(nextIntegrity)).toBe(null);
    expect(Object.prototype.hasOwnProperty.call({}, "__proto__")).toBe(false);
  });
});
