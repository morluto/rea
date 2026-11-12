import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseFragment, type DefaultTreeAdapterTypes } from "parse5";
import { createMarkdownRenderer, disposeMdItInstance } from "vitepress";
import { expect, it } from "vitest";
import {
  installCanonicalSkill,
  skillDestinations,
} from "../../../src/application/SetupSkill.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

// Original guide at main 72d5e72e6, rendered with the repository Markdown stack.
// Moving a section must retain its old fragment through a heading or HTML anchor.
const legacyAnchors = [
  "apple-app-resources",
  "apple-ips-crash-reports",
  "binary-hardening",
  "bridge-request-ceiling",
  "bun-standalone-executables",
  "continue-editable-ghidra-analysis-across-processes",
  "cpython-pyc-files",
  "desktop-installation-directories",
  "dos-mz-with-ghidra",
  "elf-note-tables",
  "erlang-beam-files",
  "esp-flash-images",
  "esp-images",
  "function-annotations-in-ghidra",
  "ghidra-startup-deadline-recovery",
  "go-build-metadata",
  "godot-pck",
  "il2cpp-metadata",
  "linux-kernel-modules",
  "managed-pe-cli",
  "model-files",
  "native-managed-and-packaged-artifacts",
  "native-targets",
  "net-nativeaot",
  "offline-apk-signatures",
  "offline-elf-layout",
  "offline-pe-and-elf-export-tables",
  "offline-pe-resource-inventory",
  "offline-wasm",
  "packages-and-extraction",
  "pe-authenticode-certificate-tables",
  "pe-import-and-delay-load-tables",
  "pe-tls-callbacks-and-load-configuration",
  "recorded-linux-crashes",
  "reuse-caller-selected-ghidra-analysis",
  "rust-dependency-metadata",
  "selected-native-facts-and-call-graphs",
  "sqlite-snapshots",
  "static-memory-and-original-file-bytes",
];

it("preserves pre-refactor native-guide fragments in an installed skill", async () => {
  const home = await createTestTempDirectory("rea-skill-anchors-");
  const installed = await installCanonicalSkill(home, []);
  if (!installed.ok) throw installed.error;
  const [destination] = skillDestinations(home, []);
  if (destination === undefined)
    throw new Error("Missing installed skill root");
  const content = await readFile(
    join(destination.path, "references/native-and-artifacts.md"),
    "utf8",
  );
  const renderer = await createMarkdownRenderer(destination.path, {
    highlight: () => "",
  });
  try {
    const ids = new Set<string>();
    const fragments: string[] = [];
    const visit = (node: DefaultTreeAdapterTypes.Node): void => {
      if ("attrs" in node)
        for (const attribute of node.attrs) {
          if (attribute.name === "id") ids.add(attribute.value);
          if (attribute.name === "href" && attribute.value.startsWith("#"))
            fragments.push(decodeURIComponent(attribute.value.slice(1)));
        }
      if ("childNodes" in node)
        for (const child of node.childNodes) visit(child);
    };
    visit(parseFragment(renderer.render(content)));
    expect([...ids]).toEqual(expect.arrayContaining(legacyAnchors));
    for (const fragment of fragments)
      expect(ids.has(fragment), `Missing rendered fragment: ${fragment}`).toBe(
        true,
      );
  } finally {
    disposeMdItInstance();
  }
});
