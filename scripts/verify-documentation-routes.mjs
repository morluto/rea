import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import { basename, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// Public route baseline before categorization, including upstream signal recordings.
// This fixture is independent of the navigation/rewrite implementation.
const routes = `
adb-device-analysis android-analysis apktool-resource-analysis apple-application-analysis
binary-diagnostics browser-observation browser-scenario-contract cli client-configuration
client-verification electron-observation evm-bytecode firmware-analysis flutter-analysis
frida-instrumentation ghidra-dos ghidra-mips ghidra-nativeaot ghidra-provider ghidra-psp
ghidra-riscv go-binaries harmony-analysis http3-capture-lab ida-provider installation
javascript-application-graph javascript-application-workflows javascript-artifact-reconstruction
javascript-recovery javascript-runtime-observation javascript-runtime-reconciliation
jeb-analysis managed-code-analysis mcp-contracts mcp-prompts migration-6.2
native-investigation packet-captures pcap-analysis process-capture raw-binary reconstruction-obligation-ledgers
reconstruction-readiness recorded-crashes releasing roadmap signal-recordings sqlite-databases
testing tool-design wasm-artifacts web-network-captures web-runtime web-source-location
website-module-trace website-script-export windows-ghidra-p0
binary-hardening desktop-application-capture desktop-application-export desktop-application-state
desktop-application-tasks desktop-build-computer desktop-build-witness ines-containers
design/limits-and-recovery
`
  .trim()
  .split(/\s+/u);
assert.equal(routes.length, 67);
assert.equal(new Set(routes).size, routes.length);

const documentation = resolve(
  fileURLToPath(new URL("../docs/", import.meta.url)),
);
const output = resolve(documentation, ".vitepress/dist");
const origin = "https://documentation.invalid";
try {
  await stat(output);
} catch (error) {
  if (error?.code === "ENOENT")
    throw new Error(
      `Documentation output is missing at ${output}; run \"npm run docs:build\" before verifying routes`,
    );
  throw error;
}
const checked = new Set();
let internalTargets = 0;
let sourceLinks = 0;
// Legacy public routes remain an independent baseline; all generated pages also
// participate so newly authored directories/specifications cannot escape checks.
for (const route of routes) {
  const html = await readFile(resolve(output, route + ".html"), "utf8");
  const edit = physicalEditSource(html, route);
  assert.equal(basename(edit), basename(route) + ".md");
}
const htmlPages = [];
const directories = [output];
while (directories.length > 0) {
  const directory = directories.pop();
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) directories.push(path);
    else if (entry.isFile() && entry.name.endsWith(".html"))
      htmlPages.push(path);
  }
}
for (const page of htmlPages.sort()) {
  const route = page
    .slice(output.length + 1)
    .split(sep)
    .join("/");
  const html = await readFile(page, "utf8");
  // The configured home layout and generated 404 render no edit action.
  // Their outgoing links still participate in the same all-page scan.
  if (route !== "404.html" && route !== "index.html") {
    const source = physicalEditSource(html, route);
    assert.ok(
      (await stat(source)).isFile(),
      route + ": edit link source is missing",
    );
    sourceLinks++;
  }
  for (const match of html.matchAll(
    /<(?:a|img)\b[^>]*\b(?:href|src)="([^"]+)"/gu,
  )) {
    const destination = match[1].replaceAll("&amp;", "&");
    const url = new URL(destination, origin + "/rea/" + route);
    if (url.origin !== origin) continue;
    assert.ok(
      url.pathname.startsWith("/rea/"),
      route + ": local link escaped site base " + destination,
    );
    const key = url.pathname + url.hash;
    if (checked.has(key)) continue;
    checked.add(key);
    let target = decodeURIComponent(url.pathname.slice("/rea/".length));
    if (!target || target.endsWith("/")) target += "index.html";
    else if (!basename(target).includes(".")) target += ".html";
    const physical = resolve(output, target);
    assert.ok(
      physical.startsWith(output + sep),
      destination + ": published path escaped site output",
    );
    assert.ok(
      (await stat(physical)).isFile(),
      route + ": broken rendered target " + destination,
    );
    if (url.hash && target.endsWith(".html")) {
      const fragment = decodeURIComponent(url.hash.slice(1));
      const page = await readFile(physical, "utf8");
      assert.ok(
        page.includes('id="' + fragment + '"'),
        route + ": missing rendered anchor " + destination,
      );
    }
    internalTargets++;
  }
}
function physicalEditSource(html, route) {
  const edit = html.match(
    /href="https:\/\/github\.com\/morluto\/rea\/edit\/main\/docs\/([^"]+)"/u,
  );
  assert.ok(edit, route + ": missing physical-source edit link");
  const source = resolve(documentation, decodeURIComponent(edit[1]));
  assert.ok(
    source.startsWith(documentation + sep),
    route + ": source escaped documentation root",
  );
  return source;
}
console.log(
  JSON.stringify({
    ok: true,
    published_routes: routes.length,
    html_pages: htmlPages.length,
    physical_edit_links: sourceLinks,
    distinct_internal_targets_and_anchors: internalTargets,
    scope:
      "actual generated HTML, local guide routes/edit sources/images and anchors; external network links are not fetched",
  }),
);
