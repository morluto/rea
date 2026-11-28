import { importVerifierSource } from "./lib/verifier-source-loader.mjs";

import { access, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { DEFAULT_CATALOG_IDENTITY } from "../dist/contracts/catalog/catalogIdentity.js";

import { parseTarListing } from "./lib/verify-package-listing.mjs";
import { runSettledConcurrent } from "./lib/verify-package-core.mjs";
import { verifyPackedBridge } from "./verify-packed-bridge.mjs";
import {
  pluginPackageMetadata,
  pluginPlatformPackages,
} from "./lib/plugin-package.mjs";

const { parseSkillManifestMetadata } = await importVerifierSource(
  new URL("../src/domain/skillManifest.ts", import.meta.url).href,
  import.meta.url,
);

/** Create a tarball and assert production packaging constraints. */
export async function verifyPackagePack({ root, workspace, commands }) {
  const packDirectory = join(workspace, "pack");
  const stagingDirectory = join(workspace, "plugin-package");
  await runSettledConcurrent(
    [packDirectory, stagingDirectory],
    2,
    (directory) => mkdir(directory),
  );
  const [{ files }] = JSON.parse(
    (await commands.execNpm(["pack", "--dry-run", "--json"], { cwd: root }))
      .stdout,
  );
  // Reuse npm's file selection, then project metadata in an owned directory.
  // Source files and the development lock are never rewritten by packaging.
  const copyPlan = files.map(({ path }) => {
    const source = resolve(root, path);
    const contained = relative(root, source);
    if (
      contained === ".." ||
      contained.startsWith(`..${sep}`) ||
      isAbsolute(contained)
    )
      throw new Error(`npm selected a path outside the package: ${path}`);
    return { source, destination: join(stagingDirectory, contained) };
  });
  await runSettledConcurrent(
    [...new Set(copyPlan.map(({ destination }) => dirname(destination)))],
    32,
    (directory) => mkdir(directory, { recursive: true }),
  );
  await runSettledConcurrent(copyPlan, 32, ({ source, destination }) =>
    copyFile(source, destination),
  );
  const { packageJson, shrinkwrap } = pluginPackageMetadata(
    JSON.parse(await readFile(join(root, "package.json"), "utf8")),
    JSON.parse(await readFile(join(root, "package-lock.json"), "utf8")),
  );
  await writeFile(
    join(stagingDirectory, "package.json"),
    `${JSON.stringify(packageJson, null, 2)}\n`,
  );
  await writeFile(
    join(stagingDirectory, "npm-shrinkwrap.json"),
    `${JSON.stringify(shrinkwrap, null, 2)}\n`,
  );
  // Materialize exactly the locked runtime tree without executing installers.
  await commands.installWithoutScripts(
    "ci",
    ["--omit=dev", "--no-audit", "--no-fund"],
    { cwd: stagingDirectory },
  );
  // npm ci filters foreign-platform optional packages. Include the exact locked
  // native archives every supported host needs (PTY, XZ decoder, ...), without
  // re-resolving the installed dependency tree.
  const platformPackages = pluginPlatformPackages(shrinkwrap);
  const platformDirectory = join(workspace, "plugin-platform-packages");
  await mkdir(platformDirectory);
  for (const locked of platformPackages) {
    const destination = join(stagingDirectory, locked.path);
    if (
      await access(destination).then(
        () => true,
        (cause) => {
          if (cause.code !== "ENOENT") throw cause;
          return false;
        },
      )
    )
      continue;
    const [archive] = JSON.parse(
      (
        await commands.execNpm(
          [
            "pack",
            "--ignore-scripts",
            "--json",
            "--pack-destination",
            platformDirectory,
            `${locked.name}@${locked.version}`,
          ],
          { cwd: platformDirectory },
        )
      ).stdout,
    );
    if (archive.integrity !== locked.integrity)
      throw new Error(
        `Plugin platform archive differs from the lock: ${locked.name}`,
      );
    await mkdir(destination, { recursive: true });
    await commands.exec("tar", [
      "-xzf",
      join(platformDirectory, archive.filename),
      "-C",
      destination,
      "--strip-components=1",
    ]);
  }
  const tarball = join(
    packDirectory,
    (
      await commands.execNpm(
        ["pack", "--silent", "--pack-destination", packDirectory],
        {
          cwd: stagingDirectory,
        },
      )
    ).stdout.trim(),
  );
  const listingOutput = await commands.exec("tar", ["-tf", tarball]);
  const packedFiles = parseTarListing(listingOutput.stdout);
  const packedFileSet = new Set(packedFiles);
  const metadataDirectory = join(workspace, "packed-metadata");
  await mkdir(metadataDirectory);
  const metadataCandidates = [
    "package/package.json",
    "package/npm-shrinkwrap.json",
    "package/skills/reverse-engineer-anything/SKILL.md",
    "package/.claude-plugin/plugin.json",
    "package/.codex-plugin/plugin.json",
    "package/.codex-plugin/mcp.json",
    "package/.cursor-plugin/plugin.json",
    "package/mcp.json",
  ].filter((archivePath) => packedFileSet.has(archivePath));
  if (metadataCandidates.length > 0) {
    await commands.exec("tar", [
      "-xzf",
      tarball,
      "-C",
      metadataDirectory,
      ...metadataCandidates,
    ]);
  }
  const readPackedText = async (archivePath) => {
    if (!packedFileSet.has(archivePath))
      throw new Error(`package omitted ${archivePath}`);
    return readFile(join(metadataDirectory, archivePath), "utf8");
  };
  const readPackedJson = async (archivePath) =>
    JSON.parse(await readPackedText(archivePath));
  const packedManifest = await readPackedJson("package/package.json");
  if (packedManifest.mcpName !== "io.github.morluto/rea")
    throw new Error("package did not retain its MCP Registry ownership marker");
  const packedLock = await readPackedJson("package/npm-shrinkwrap.json");
  if (
    packedManifest.overrides !== undefined ||
    packedManifest.devDependencies !== undefined ||
    ![2, 3].includes(packedLock.lockfileVersion) ||
    packedLock.version !== packedManifest.version ||
    packedLock.packages?.[""].version !== packedManifest.version ||
    JSON.stringify(packedLock.packages?.[""].dependencies) !==
      JSON.stringify(packedManifest.dependencies) ||
    JSON.stringify(packedLock.packages?.[""].optionalDependencies) !==
      JSON.stringify(packedManifest.optionalDependencies)
  )
    throw new Error(
      "package is not installable under the Claude plugin dependency policy",
    );
  for (const dependency of Object.keys(packedManifest.dependencies))
    if (
      !packedFiles.includes(`package/node_modules/${dependency}/package.json`)
    )
      throw new Error(
        `Plugin runtime dependency is not bundled: ${dependency}`,
      );
  for (const { name, path } of pluginPlatformPackages(packedLock))
    if (!packedFileSet.has(`package/${path}/package.json`))
      throw new Error(`Plugin platform dependency is missing: ${name}`);
  if (
    packedManifest.scripts?.postinstall !== undefined ||
    packedManifest.dependencies?.["node-pty"] !== undefined ||
    packedManifest.dependencies?.["@lydell/node-pty"] !== "1.1.0"
  )
    throw new Error("package retained a lifecycle-dependent PTY installation");
  if (
    packedManifest.bin?.rea !== "scripts/rea.mjs" ||
    packedManifest.bin?.["rea-agents"] !== "scripts/rea.mjs"
  )
    throw new Error("package did not expose both rea command entry points");
  if (!packedFiles.includes("package/scripts/lib/cli-compiled-runtime.mjs"))
    throw new Error("package omitted the compiled CLI runtime check");
  if (!packedFiles.includes("package/scripts/lib/cli-process-environment.mjs"))
    throw new Error("package omitted the CLI process environment owner");
  if (!packedFiles.includes("package/scripts/lib/runtime-admission.mjs"))
    throw new Error("package omitted the CLI runtime admission owner");
  if (packedFiles.some((path) => path.startsWith("package/.agents/")))
    throw new Error(
      "package included authored skill sources instead of only the generated bundle",
    );
  if (packedFiles.some((path) => path.startsWith("package/src/")))
    throw new Error(
      "Packaged runtime must not masquerade as a source checkout",
    );
  if (packedFiles.some((path) => path.startsWith("package/.cache/")))
    throw new Error("package included development cache or test metadata");
  const skill = await readPackedText(
    "package/skills/reverse-engineer-anything/SKILL.md",
  );
  const skillMetadata = parseSkillManifestMetadata(skill);
  if (
    !skillMetadata.ok ||
    skillMetadata.value.toolCount !==
      DEFAULT_CATALOG_IDENTITY.counts.mcp_tools ||
    skillMetadata.value.hasCatalogDigest
  )
    throw new Error(
      "packaged skill metadata did not match the catalog shipped in the package",
    );
  for (const path of [
    ".claude-plugin/plugin.json",
    ".codex-plugin/plugin.json",
  ]) {
    const manifest = await readPackedJson(`package/${path}`);
    const serverConfig = path.startsWith(".codex")
      ? await readPackedJson("package/.codex-plugin/mcp.json")
      : manifest;
    const expectedArgs = [
      `${path.startsWith(".claude") ? "${CLAUDE_PLUGIN_ROOT}/" : "./"}scripts/plugin-mcp-launcher.mjs`,
      packedManifest.version,
    ];
    if (
      manifest.version !== packedManifest.version ||
      manifest.skills !== "./skills" ||
      (path.startsWith(".codex")
        ? manifest.mcpServers !== "./.codex-plugin/mcp.json" ||
          serverConfig.mcpServers?.rea?.cwd !== "." ||
          serverConfig.mcpServers?.rea?.startup_timeout_sec !== 30
        : false) ||
      serverConfig.mcpServers?.rea?.command !== "node" ||
      JSON.stringify(serverConfig.mcpServers?.rea?.args) !==
        JSON.stringify(expectedArgs)
    )
      throw new Error(
        `Packaged plugin ${path} does not match the exact runtime and canonical skill release`,
      );
    const icons = path.startsWith(".codex")
      ? [manifest.interface?.logo, manifest.interface?.composerIcon]
      : [manifest.icon];
    for (const icon of icons)
      if (
        icon !== "./assets/rea-plugin.png" ||
        !packedFiles.includes(`package/${icon.slice(2)}`)
      )
        throw new Error(`Packaged plugin ${path} is missing its shared icon`);
  }
  const cursorManifest = await readPackedJson(
    "package/.cursor-plugin/plugin.json",
  );
  const cursorServer = await readPackedJson("package/mcp.json");
  const cursorLogo = String(cursorManifest.logo ?? "").replace(/^\.\//u, "");
  const cursorSkill =
    "package/.cursor-plugin/skills/reverse-engineer-anything/SKILL.md";
  if (
    cursorManifest.version !== packedManifest.version ||
    cursorManifest.skills !== ".cursor-plugin/skills" ||
    cursorLogo !== "assets/rea-plugin.png" ||
    cursorManifest.mcpServers !== undefined ||
    cursorServer.mcpServers?.rea?.command !== "npx" ||
    JSON.stringify(cursorServer.mcpServers?.rea?.args) !==
      JSON.stringify([
        "-y",
        `${packedManifest.name}@${packedManifest.version}`,
        "mcp",
      ]) ||
    !packedFiles.includes(`package/${cursorLogo}`) ||
    !packedFiles.includes(cursorSkill)
  )
    throw new Error(
      "Packaged Cursor plugin does not ship the pinned server, skill, and logo",
    );
  if (packedFiles.includes("package/.mcp.json"))
    throw new Error("Plugin metadata must not register a project MCP server");
  if (!packedFiles.includes("package/.codex-plugin/mcp.json"))
    throw new Error("Packaged Codex MCP server declaration is missing");
  if (!packedFiles.includes("package/scripts/plugin-mcp-launcher.mjs"))
    throw new Error("Packaged plugin launcher is missing");
  if (
    skill.includes(`${packedManifest.name}@latest`) ||
    !skill.includes(`${packedManifest.name}@${packedManifest.version}`)
  )
    throw new Error(
      "Packaged plugin skill recovery is not pinned to the shipped runtime",
    );
  await verifyPackedBridge({ tarball, packedFiles, commands });
  return { tarball };
}
