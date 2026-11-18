import { expect, it } from "vitest";

import type { JavaScriptArtifactFile } from "../../domain/javascript/javascriptArtifactFiles.js";
import { JavaScriptJsonDocuments } from "./JavaScriptJsonDocuments.js";
import { createJavaScriptNextAppContext } from "./JavaScriptNextAppContext.js";

const contextFor = (
  files: readonly JavaScriptArtifactFile[],
  directories: ReadonlySet<string>,
) =>
  createJavaScriptNextAppContext(
    { files, unavailable_relevant_files: [] },
    new JavaScriptJsonDocuments(),
    directories,
    { scope: "container-entries", status: "complete" },
  );

const file = (path: string, text = ""): JavaScriptArtifactFile => ({
  path,
  container_sha256: "a".repeat(64),
  sha256: "b".repeat(64),
  bytes: Buffer.byteLength(text),
  inventory_artifact_id: `art_${"b".repeat(64)}`,
  kind: path.endsWith("package.json") ? "package-json" : "javascript",
  unpacked: false,
  text: { included: true, value: text },
});

it("keeps readable package applicability scoped to its source container", () => {
  const manifest = file("package.json", '{"dependencies":{"next":"16.4.2"}}');
  const foreign = {
    ...file("package.json", '{"name":"plain"}'),
    container_sha256: "c".repeat(64),
  };
  const page = file("app/page.js");
  const foreignPage = { ...page, container_sha256: foreign.container_sha256 };
  const context = contextFor(
    [manifest, foreign, page, foreignPage],
    new Set(["app"]),
  );
  expect(context(page)).toMatchObject({
    kind: "app-directory",
    package: { container_sha256: manifest.container_sha256 },
  });
  expect(context(foreignPage)).toMatchObject({
    kind: "unknown",
    package: { container_sha256: foreign.container_sha256 },
  });
});

it("keeps default compiled output under its declared package and unrelated chunk-like paths unknown", () => {
  const manifest = file("package.json", '{"dependencies":{"next":"16.4.2"}}');
  const chunk = file(".next/static/chunks/app/build/page-abc.js");
  const context = contextFor([manifest, chunk], new Set());
  expect(context(chunk)).toMatchObject({
    kind: "compiled-directory",
    directory: ".next/static/chunks/app",
  });
  expect(contextFor([chunk], new Set())(chunk)).toMatchObject({
    kind: "unknown",
    package: null,
  });
});

it("does not infer absent manifests or higher-priority directories from incomplete traversal", () => {
  const manifest = file("package.json", '{"dependencies":{"next":"16.4.2"}}');
  const page = file("src/app/control/page.js");
  const files = { files: [manifest, page], unavailable_relevant_files: [] };
  const context = createJavaScriptNextAppContext(
    files,
    new JavaScriptJsonDocuments(),
    new Set(["src/app"]),
    { scope: "container-entries", status: "unknown" },
  );
  expect(context(page)).toMatchObject({
    kind: "unknown",
    package: null,
    reason: expect.stringContaining("src/app/control/package.json"),
  });
  const rootPage = file("page.js");
  expect(context(rootPage)).toMatchObject({
    kind: "unknown",
    package: { path: "package.json" },
    reason: expect.stringContaining("higher-priority app directory"),
  });
});

it("retains the nearest unavailable manifest's evidence instead of borrowing an ancestor's Next declaration", () => {
  const parent = file("package.json", '{"dependencies":{"next":"16.4.2"}}');
  const page = file("app/widget/app/page.js");
  const unavailable = {
    path: "app/widget/package.json",
    container_sha256: parent.container_sha256,
    sha256: null,
    bytes: 42,
    inventory_artifact_id: null,
    inventory_occurrence_id: "unreadable-nested-package",
    kind: "package-json" as const,
    limitations: ["The unpacked package companion is missing."],
  };
  const foreignContainer = "c".repeat(64);
  const foreignParent = { ...parent, container_sha256: foreignContainer };
  const foreignPage = { ...page, container_sha256: foreignContainer };
  const context = createJavaScriptNextAppContext(
    {
      files: [parent, page, foreignParent, foreignPage],
      unavailable_relevant_files: [unavailable],
    },
    new JavaScriptJsonDocuments(),
    new Set(["app", "app/widget/app"]),
    { scope: "container-entries", status: "complete" },
  );
  const result = context(page);
  expect(result).toMatchObject({ kind: "unknown", package: null });
  if (result.kind !== "unknown")
    throw new Error("Expected unknown package ownership");
  expect(result.reason).toContain(unavailable.path);
  expect(result.reason).toContain(unavailable.inventory_occurrence_id);
  expect(result.reason).toContain(unavailable.limitations[0]);
  expect(context(foreignPage)).toMatchObject({
    kind: "app-directory",
    directory: "app",
    package: { path: parent.path, container_sha256: foreignContainer },
  });
});
