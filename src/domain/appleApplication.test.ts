import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { projectAppleApplication } from "./appleApplication.js";
import { canonicalDigest } from "./comparisonSemantics.js";
import { createEvidence, type Evidence } from "./evidence.js";
import { jsonValueSchema } from "./jsonValue.js";

type EntryKind = "file" | "directory" | "symlink";
type RootFormat = "ipa" | "zip" | "dmg" | "directory" | "asar";

interface FixtureEntry {
  readonly path: string;
  readonly kind?: EntryKind;
  readonly format?: string;
}

const sha = (text: string): string =>
  createHash("sha256").update(text).digest("hex");
const artifactId = (sha256: string): string =>
  `art_${canonicalDigest({ sha256 }, "Artifact inventory")}`;

/** Build one complete, content-addressed inventory page for pure projection tests. */
const inventoryEvidence = (
  rootFormat: RootFormat,
  subjectName: string,
  entries: readonly FixtureEntry[],
): Evidence => {
  const rootSha = sha(`${rootFormat}:${subjectName}`);
  const rootId = artifactId(rootSha);
  const node = (sha256: string, format: string) => ({
    artifact_id: artifactId(sha256),
    kind: "resource",
    format,
    sha256,
    size: 1,
    media_type: null,
    architecture: null,
    executable: false,
    content_state: "materialized",
    limitations: [],
  });
  const occurrence = (path: string, kind: EntryKind, id: string | null) => ({
    occurrence_id:
      path === "."
        ? `occ_${canonicalDigest({ root: rootId }, "Artifact inventory")}`
        : `occ_${canonicalDigest(
            { root_artifact_id: rootId, logical_path: path, entry_kind: kind },
            "Artifact inventory",
          )}`,
    artifact_id: id,
    parent_occurrence_id: null,
    logical_path: path,
    entry_kind: kind,
    declared_size: null,
    compressed_size: null,
    executable: false,
    encrypted: false,
    hash_status: "verified",
    source_location: null,
    limitations: [],
  });
  const nodes = new Map([[rootId, node(rootSha, rootFormat)]]);
  const occurrences = [occurrence(".", "file", rootId)];
  for (const { path, kind = "file", format = "file" } of entries) {
    if (kind === "symlink") {
      occurrences.push(occurrence(path, kind, null));
      continue;
    }
    const contentSha = sha(`${kind}:${path}`);
    const id = artifactId(contentSha);
    nodes.set(
      id,
      node(contentSha, kind === "directory" ? "directory" : format),
    );
    occurrences.push(occurrence(path, kind, id));
  }
  const sortedNodes = [...nodes.values()].sort((left, right) =>
    left.artifact_id.localeCompare(right.artifact_id),
  );
  const sortedOccurrences = occurrences.sort((left, right) =>
    left.logical_path.localeCompare(right.logical_path, "en"),
  );
  const graphSha256 = canonicalDigest(
    {
      nodes: sortedNodes,
      occurrences: sortedOccurrences,
      edges: [],
      integrity_contradictions: [],
    },
    "Artifact inventory",
  );
  return createEvidence(
    {
      path: `/fixtures/${subjectName}`,
      sha256: rootSha,
      format: rootFormat,
    },
    { id: "rea-artifact-graph", name: "fixture", version: "1" },
    {
      operation: "inventory_artifact",
      parameters: {},
      confidence: "observed",
      authority: "shipped-artifact",
      result: jsonValueSchema.parse({
        manifest: {
          manifest_id: `agm_${canonicalDigest(
            { root_artifact_id: rootId, graph_sha256: graphSha256 },
            "Artifact inventory",
          )}`,
          root_artifact_id: rootId,
          root_sha256: rootSha,
          root_format: rootFormat,
          graph_sha256: graphSha256,
          node_count: sortedNodes.length,
          occurrence_count: sortedOccurrences.length,
          edge_count: 0,
        },
        nodes: sortedNodes,
        occurrences: sortedOccurrences,
        edges: [],
        provenance: [],
        limitations: [],
      }),
    },
  );
};

const project = (evidence: Evidence) =>
  projectAppleApplication({ inventory_evidence: [evidence] });

const macho = (path: string): FixtureEntry => ({ path, format: "mach-o" });

describe("macOS application roots and bundle roles", () => {
  it("treats an inventoried .app directory as its own application root", () => {
    const result = project(
      inventoryEvidence("directory", "Fixture.app", [
        { path: "Contents/Info.plist" },
        macho("Contents/MacOS/Fixture"),
        { path: "Contents/_CodeSignature/CodeResources" },
        { path: "Contents/embedded.provisionprofile" },
        macho("Contents/Library/LaunchServices/com.example.helper"),
        { path: "Contents/Library/LaunchDaemons/com.example.helper.plist" },
        { path: "Contents/Library/LaunchAgents/com.example.agent.plist" },
        macho("Contents/Helpers/tool"),
        macho("Contents/Helpers/Assistant.app/Contents/MacOS/Assistant"),
        macho(
          "Contents/Library/SystemExtensions/com.example.filter.systemextension/Contents/MacOS/com.example.filter",
        ),
        macho(
          "Contents/Library/SystemExtensions/com.example.driver.dext/driver",
        ),
        { path: "Contents/PlugIns/Preview.qlgenerator", kind: "directory" },
        macho("Contents/PlugIns/Bridge.bundle/Contents/MacOS/Bridge"),
        { path: "Contents/Resources/Strings.bundle/Info.plist" },
        { path: "Contents/SharedSupport/Data.bundle", kind: "directory" },
        macho("Contents/Resources/Embedded.app/Contents/MacOS/Embedded"),
      ]),
    );
    expect(result).toMatchObject({
      root_format: "directory",
      platforms: ["macos"],
      application_roots: ["."],
    });
    expect(
      result.bundles.map(({ path, role, layout, parent_path: parent }) => ({
        path,
        role,
        layout,
        parent,
      })),
    ).toEqual([
      { path: ".", role: "application", layout: "macos-deep", parent: null },
      {
        path: "Contents/Helpers/Assistant.app",
        role: "helper-application",
        layout: "macos-deep",
        parent: ".",
      },
      {
        path: "Contents/Library/SystemExtensions/com.example.driver.dext",
        role: "driver-extension",
        layout: "shallow",
        parent: ".",
      },
      {
        path: "Contents/Library/SystemExtensions/com.example.filter.systemextension",
        role: "system-extension",
        layout: "macos-deep",
        parent: ".",
      },
      {
        path: "Contents/PlugIns/Bridge.bundle",
        role: "plug-in",
        layout: "macos-deep",
        parent: ".",
      },
      {
        path: "Contents/PlugIns/Preview.qlgenerator",
        role: "plug-in",
        layout: "shallow",
        parent: ".",
      },
      {
        path: "Contents/Resources/Embedded.app",
        role: "nested-application",
        layout: "macos-deep",
        parent: ".",
      },
      {
        path: "Contents/Resources/Strings.bundle",
        role: "resource-bundle",
        layout: "shallow",
        parent: ".",
      },
      {
        path: "Contents/SharedSupport/Data.bundle",
        role: "bundle",
        layout: "shallow",
        parent: ".",
      },
    ]);
    expect(result.bundles[0]).toMatchObject({
      info_plist_path: "Contents/Info.plist",
      executable_candidates: ["Contents/MacOS/Fixture"],
      signing_paths: [
        "Contents/_CodeSignature/CodeResources",
        "Contents/embedded.provisionprofile",
      ],
    });
    expect(
      result.components.privileged_helpers.map(({ path }) => path),
    ).toEqual(["Contents/Library/LaunchServices/com.example.helper"]);
    expect(
      result.components.launchd_plists.map(({ path, domain }) => [
        path,
        domain,
      ]),
    ).toEqual([
      ["Contents/Library/LaunchAgents/com.example.agent.plist", "agent"],
      ["Contents/Library/LaunchDaemons/com.example.helper.plist", "daemon"],
    ]);
    expect(result.components.helpers.map(({ path }) => path)).toEqual([
      "Contents/Helpers/tool",
    ]);
  });

  it("does not make a non-application bundle directory an application root", () => {
    const result = project(
      inventoryEvidence("directory", "Service.xpc", [
        { path: "Contents/Info.plist" },
        macho("Contents/MacOS/Service"),
      ]),
    );
    expect(result.application_roots).toEqual([]);
    expect(result.bundles).toEqual([]);
    expect(result.limitations).toContain(
      "No application bundle (Payload/*.app or *.app/Contents) was present in the supplied inventory pages.",
    );
  });
});

describe("Apple bundle layouts and containers", () => {
  it("follows versioned frameworks without resolving Versions/Current", () => {
    const framework = "Fixture.app/Contents/Frameworks/Core.framework";
    const result = project(
      inventoryEvidence("zip", "Fixture.zip", [
        macho("Fixture.app/Contents/MacOS/Fixture"),
        { path: `${framework}/Core`, kind: "symlink" },
        { path: `${framework}/Versions/Current`, kind: "symlink" },
        macho(`${framework}/Versions/A/Core`),
        { path: `${framework}/Versions/A/Resources/Info.plist` },
        { path: `${framework}/Versions/A/_CodeSignature/CodeResources` },
        macho(
          `${framework}/Versions/A/XPCServices/Fetch.xpc/Contents/MacOS/Fetch`,
        ),
      ]),
    );
    const core = result.bundles.find(({ path }) => path === framework);
    expect(core).toEqual({
      path: framework,
      parent_path: "Fixture.app",
      layout: "versioned-framework",
      role: "framework",
      role_basis: "path-convention",
      info_plist_path: `${framework}/Versions/A/Resources/Info.plist`,
      executable_candidates: [`${framework}/Versions/A/Core`],
      signing_paths: [`${framework}/Versions/A/_CodeSignature/CodeResources`],
    });
    expect(
      result.bundles.find(({ role }) => role === "xpc-service")?.parent_path,
    ).toBe(framework);
    expect(result.symlinks).toEqual([
      `${framework}/Core`,
      `${framework}/Versions/Current`,
    ]);
  });

  it("reports an unknown Info.plist when several framework versions exist", () => {
    const framework = "Fixture.app/Contents/Frameworks/Core.framework";
    const result = project(
      inventoryEvidence("zip", "Fixture.zip", [
        macho("Fixture.app/Contents/MacOS/Fixture"),
        { path: `${framework}/Versions/A/Resources/Info.plist` },
        { path: `${framework}/Versions/B/Resources/Info.plist` },
      ]),
    );
    expect(
      result.bundles.find(({ path }) => path === framework)?.info_plist_path,
    ).toBeNull();
    expect(result.limitations).toContainEqual(
      expect.stringContaining("Versions/Current selects is unknown"),
    );
  });

  it("excludes AppleDouble sidecars from roots and roles", () => {
    const result = project(
      inventoryEvidence("zip", "Fixture.zip", [
        macho("Fixture.app/Contents/MacOS/Fixture"),
        { path: "Fixture.app/Contents/Library/LaunchDaemons/._helper.plist" },
        { path: "Fixture.app/Contents/Library/LaunchDaemons/helper.plist" },
        { path: "__MACOSX/Other.app/Contents/._Info.plist" },
      ]),
    );
    expect(result.application_roots).toEqual(["Fixture.app"]);
    expect(result.components.launchd_plists.map(({ path }) => path)).toEqual([
      "Fixture.app/Contents/Library/LaunchDaemons/helper.plist",
    ]);
    expect(result.limitations).toContainEqual(
      expect.stringContaining("AppleDouble sidecar entries"),
    );
  });

  it("reports a DMG without inventoried contents as partial", () => {
    const result = project(inventoryEvidence("dmg", "Fixture.dmg", []));
    expect(result.coverage).toEqual({
      status: "partial",
      inventory_complete: true,
    });
    expect(result.limitations).toContain(
      "The DMG's contents were not inventoried on this host; bundle absence is unknown.",
    );
  });

  it("keeps IPA applications shallow and iOS", () => {
    const result = project(
      inventoryEvidence("ipa", "Fixture.ipa", [
        { path: "Payload/Fixture.app/Info.plist" },
        macho("Payload/Fixture.app/Fixture"),
        { path: "Payload/Fixture.app/embedded.mobileprovision" },
        macho("Payload/Fixture.app/PlugIns/Share.appex/Share"),
        macho("SwiftSupport/iphoneos/libswiftCore.dylib"),
      ]),
    );
    expect(result.platforms).toEqual(["ios"]);
    // IPA projection still lists archive components outside Payload/.
    expect(result.components.native_libraries.map(({ path }) => path)).toEqual([
      "SwiftSupport/iphoneos/libswiftCore.dylib",
    ]);
    expect(
      result.bundles.map(({ path, role, layout }) => [path, role, layout]),
    ).toEqual([
      ["Payload/Fixture.app", "application", "shallow"],
      ["Payload/Fixture.app/PlugIns/Share.appex", "app-extension", "shallow"],
    ]);
    expect(result.bundles[0]?.executable_candidates).toEqual([
      "Payload/Fixture.app/Fixture",
    ]);
  });

  it("rejects inventories that cannot contain an Apple application", () => {
    expect(() => project(inventoryEvidence("asar", "app.asar", []))).toThrow(
      "Apple application projection requires IPA, directory, ZIP, or DMG inventory Evidence (got asar)",
    );
  });
});

describe("macOS application scope", () => {
  it("attributes only components inside the application roots", () => {
    const result = project(
      inventoryEvidence("zip", "Distribution.zip", [
        macho("Fixture.app/Contents/MacOS/Fixture"),
        macho("Fixture.app/Contents/Frameworks/Core.framework/Versions/A/Core"),
        {
          path: "Fixture.app/Contents/Resources/app.js",
          format: "javascript-bundle",
        },
        macho("Extras/Plugin.framework/Versions/A/Plugin"),
        macho("Extras/libextra.dylib"),
        { path: "Extras/installer.js", format: "javascript-bundle" },
        { path: "Extras/Info.plist" },
      ]),
    );
    const paths = (components: readonly { readonly path: string }[]) =>
      components.map(({ path }) => path);
    expect(paths(result.components.frameworks)).toEqual([
      "Fixture.app/Contents/Frameworks/Core.framework/Versions/A/Core",
    ]);
    expect(paths(result.components.native_libraries)).toEqual([]);
    expect(paths(result.components.javascript)).toEqual([
      "Fixture.app/Contents/Resources/app.js",
    ]);
    expect(paths(result.components.bundle_metadata)).toEqual([]);
    expect(
      result.bridge_candidates.every(
        ({ source_path: source, native_path: target }) =>
          [source, target].every((path) => path.startsWith("Fixture.app/")),
      ),
    ).toBe(true);
    expect(result.limitations).toContain(
      "4 inventoried entries outside every application root are not attributed to the application.",
    );
  });

  it("keeps a selected .app directory as the root when its contents are missing", () => {
    const empty = project(inventoryEvidence("directory", "Fixture.app", []));
    expect(empty).toMatchObject({
      application_roots: ["."],
      platforms: [],
      bundles: [
        {
          path: ".",
          role: "application",
          layout: "shallow",
          info_plist_path: null,
        },
      ],
    });
    const partial = project(
      inventoryEvidence("directory", "Fixture.app", [
        { path: "Contents/Resources/Localizable.strings" },
      ]),
    );
    expect(partial).toMatchObject({
      application_roots: ["."],
      platforms: ["macos"],
    });
  });
});
