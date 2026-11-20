import { expect, it } from "vitest";

import type { JavaScriptArtifactFile } from "../../domain/javascript/javascriptArtifactFiles.js";
import { JavaScriptJsonDocuments } from "./JavaScriptJsonDocuments.js";

type MutableArtifactFile = {
  -readonly [Key in keyof JavaScriptArtifactFile]: JavaScriptArtifactFile[Key];
};

const mutableFile = (): MutableArtifactFile => ({
  path: "package.json",
  container_sha256: "container-a",
  sha256: "file-a",
  bytes: 13,
  inventory_artifact_id: "inventory-a",
  kind: "package-json",
  unpacked: false,
  text: { included: true, value: '{"main":"a.cjs"}' },
});

it("retains only declared package metadata despite inherited host fields", () => {
  const documents = new JavaScriptJsonDocuments();
  const absentFile = mutableFile();
  absentFile.text = { included: true, value: "{}" };
  const declaredFile = mutableFile();
  declaredFile.text = {
    included: true,
    value:
      '{"name":"source-name","version":"1.0.0","main":null,"browser":"source-browser.cjs","dependencies":{"next":"source-next"}}',
  };
  const inherited = {
    name: "host-name",
    version: "host-version",
    main: "host-entry.cjs",
    renderer: "host-renderer.cjs",
    browser: "host-browser.cjs",
    module: "host-module.mjs",
    dependencies: { next: "host-next" },
    devDependencies: { next: "host-next-dev" },
    peerDependencies: { next: "host-next-peer" },
  };
  const previous = Object.fromEntries(
    Object.keys(inherited).map((key) => [
      key,
      Object.getOwnPropertyDescriptor(Object.prototype, key),
    ]),
  );
  let absent: ReturnType<JavaScriptJsonDocuments["read"]>;
  let declared: ReturnType<JavaScriptJsonDocuments["read"]>;
  let absentMain: unknown;
  let undeclaredModule: unknown;
  try {
    for (const [key, value] of Object.entries(inherited))
      Object.defineProperty(Object.prototype, key, {
        configurable: true,
        writable: true,
        value,
      });
    absent = documents.read(absentFile);
    declared = documents.read(declaredFile);
    absentMain = absent.packageFields?.main;
    undeclaredModule = declared.packageFields?.module;
  } finally {
    for (const key of Object.keys(inherited)) {
      const descriptor = previous[key];
      if (descriptor === undefined)
        Reflect.deleteProperty(Object.prototype, key);
      else Object.defineProperty(Object.prototype, key, descriptor);
    }
  }
  expect(absentMain).toBeUndefined();
  expect(undeclaredModule).toBeUndefined();
  expect(absent).toMatchObject({
    status: "included",
    nextDependency: "unproven",
  });
  expect(declared).toMatchObject({
    status: "included",
    nextDependency: "declared",
  });
  if (absent.packageFields === null || declared.packageFields === null)
    throw new Error("Expected package metadata fields");
  expect(Object.keys(absent.packageFields)).toEqual([]);
  expect(declared.packageFields).toEqual({
    name: "source-name",
    version: "1.0.0",
    main: null,
    browser: "source-browser.cjs",
  });
  expect(Object.hasOwn(declared.packageFields, "renderer")).toBe(false);
  expect(Object.hasOwn(declared.packageFields, "module")).toBe(false);
});

it("refreshes JSON facts when a reused file changes without rewriting prior evidence", () => {
  const documents = new JavaScriptJsonDocuments();
  const file = mutableFile();
  const original = documents.read(file);
  file.path = "nested/package.json";
  expect(documents.read(file).source.path).toBe("nested/package.json");
  file.container_sha256 = "container-b";
  expect(documents.read(file).source.container_sha256).toBe("container-b");
  file.sha256 = "file-b";
  expect(documents.read(file).source).toEqual({
    path: "nested/package.json",
    container_sha256: "container-b",
    sha256: "file-b",
  });

  file.text = { included: true, value: "{" };
  const invalid = documents.read(file);
  expect(invalid.status).toBe("invalid");

  file.text = { included: false, reason: "invalid-utf8" };
  const unavailable = documents.read(file);
  expect(unavailable).toMatchObject({
    status: "unavailable",
    reason: "invalid-utf8",
  });

  file.text = { included: true, value: '{"main":"b.cjs"}' };
  const updated = documents.read(file);
  expect(updated).toMatchObject({
    status: "included",
    packageFields: { main: "b.cjs" },
    source: {
      path: "nested/package.json",
      container_sha256: "container-b",
      sha256: "file-b",
    },
  });
  expect(original).toMatchObject({
    status: "included",
    source: {
      path: "package.json",
      container_sha256: "container-a",
      sha256: "file-a",
    },
    packageFields: { main: "a.cjs" },
  });
  expect(invalid.status).toBe("invalid");
  expect(unavailable.status).toBe("unavailable");
});

it("retains only syntax and keys for ordinary JSON, with package fields scoped to its format", () => {
  const documents = new JavaScriptJsonDocuments();
  const file = mutableFile();
  file.kind = "json";
  file.text = {
    included: true,
    value: '{"exports":{"nested":["large config"]},"main":"entry.cjs"}',
  };
  const ordinary = documents.read(file);
  expect(ordinary).toMatchObject({
    status: "included",
    topLevelKeys: ["exports", "main"],
    packageFields: null,
  });
  file.kind = "package-json";
  expect(documents.read(file)).toMatchObject({
    status: "included",
    packageFields: { main: "entry.cjs", exports: { nested: ["large config"] } },
  });
  expect(ordinary.packageFields).toBeNull();
});
