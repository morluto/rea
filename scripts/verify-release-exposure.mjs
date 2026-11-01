/** Audit a local Electron .app before and after fuse and source-map remediation. */
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { importVerifierSource } from "./lib/verifier-source-loader.mjs";

const exec = promisify(execFile);
const { ELECTRON_FUSE_SENTINEL } = await importVerifierSource(
  new URL("../src/domain/electron/electronFuses.ts", import.meta.url).href,
  import.meta.url,
);
const PLANTED_SOURCE = "release-exposure-planted-secret-7c2e9a";
const OUTPUT = resolve("docs/verification/release-exposure-2026-10-31.md");
const TEXT_MEMBER_BYTES = 256 * 1024;

const asarArchive = (files) => {
  let offset = 0;
  const table = {};
  const bodies = [];
  for (const file of files) {
    table[file.name] = { size: file.bytes.length, offset: String(offset) };
    bodies.push(file.bytes);
    offset += file.bytes.length;
  }
  const text = Buffer.from(JSON.stringify({ files: table }));
  const aligned = Math.ceil(text.length / 4) * 4;
  const headerSize = 8 + aligned;
  const header = Buffer.alloc(8 + headerSize);
  header.writeUInt32LE(4, 0);
  header.writeUInt32LE(headerSize, 4);
  header.writeUInt32LE(headerSize - 4, 8);
  header.writeUInt32LE(text.length, 12);
  text.copy(header, 16);
  return Buffer.concat([header, ...bodies]);
};

const frameworkBinary = (states) => {
  const header = Buffer.alloc(64);
  header[0] = 0x7f;
  header[1] = 0x45;
  header[2] = 0x4c;
  header[3] = 0x46;
  header[4] = 2;
  header[5] = 1;
  header[6] = 1;
  header.writeUInt16LE(2, 16);
  header.writeUInt16LE(62, 18);
  header.writeUInt32LE(1, 20);
  header.writeUInt16LE(64, 52);
  const wire = Buffer.concat([
    Buffer.from(ELECTRON_FUSE_SENTINEL, "ascii"),
    Buffer.from([1, states.length, ...states]),
  ]);
  return Buffer.concat([header, wire, Buffer.alloc(TEXT_MEMBER_BYTES)]);
};

const sourceMap = () =>
  Buffer.from(
    JSON.stringify({
      version: 3,
      file: "app.js",
      sources: ["app.js"],
      names: [],
      mappings: "",
      sourcesContent: [`export const secret = "${PLANTED_SOURCE}";\n`],
    }),
  );

const writeApp = async (root, { withMap, states }) => {
  const resources = join(root, "Contents", "Resources");
  const framework = join(
    root,
    "Contents",
    "Frameworks",
    "Electron Framework.framework",
  );
  await mkdir(resources, { recursive: true });
  await mkdir(framework, { recursive: true });
  const files = [{ name: "app.js", bytes: Buffer.from("console.log(1)\n") }];
  if (withMap) files.push({ name: "app.js.map", bytes: sourceMap() });
  await writeFile(join(resources, "app.asar"), asarArchive(files));
  await writeFile(
    join(framework, "Electron Framework"),
    frameworkBinary(states),
  );
};

const audit = async (directory, extraArgs = []) => {
  const args = [
    resolve("scripts/rea.mjs"),
    "audit-release-exposure",
    directory,
    "--json",
    ...extraArgs,
  ];
  try {
    const { stdout } = await exec(process.execPath, args, {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      timeout: 180000,
    });
    return { status: 0, stdout };
  } catch (cause) {
    const stdout = typeof cause.stdout === "string" ? cause.stdout : "";
    const status = typeof cause.code === "number" ? cause.code : undefined;
    if (status !== undefined && stdout.length > 0) return { status, stdout };
    throw cause;
  }
};

const checksOf = (stdout) => {
  const evidence = JSON.parse(stdout);
  const report = evidence.normalized_result;
  return report.checks.map((check) => ({
    id: check.id,
    status: check.status,
    severity: check.severity,
  }));
};

const statusOf = (checks, id) =>
  checks.find((check) => check.id === id)?.status;

const expectStatus = (label, checks, id, value) => {
  if (statusOf(checks, id) !== value)
    throw new Error(
      `${label} ${id} is ${statusOf(checks, id)}, expected ${value}`,
    );
};

const table = (checks) => {
  const rows = [
    ["Check", "Status", "Severity"],
    ...checks.map((check) => [
      `\`${check.id}\``,
      `\`${check.status}\``,
      `\`${String(check.severity)}\``,
    ]),
  ];
  const widths = rows[0].map((_, column) =>
    Math.max(...rows.map((row) => row[column].length)),
  );
  const line = (cells) =>
    `| ${cells.map((cell, column) => cell.padEnd(widths[column])).join(" | ")} |`;
  return [
    line(rows[0]),
    line(widths.map((width) => "-".repeat(width))),
    ...rows.slice(1).map(line),
  ].join("\n");
};

const installFuses = async (root) => {
  const prefix = join(root, "fuses");
  await mkdir(prefix);
  await exec("npm", ["install", "--prefix", prefix, "@electron/fuses"], {
    encoding: "utf8",
    timeout: 180000,
  });
  const packageJson = JSON.parse(
    await readFile(
      join(prefix, "node_modules", "@electron", "fuses", "package.json"),
      "utf8",
    ),
  );
  const exported = packageJson.exports;
  const dot =
    exported !== null && typeof exported === "object"
      ? exported["."]
      : exported;
  const nested = dot !== null && typeof dot === "object" ? dot : undefined;
  const entry =
    (typeof dot === "string" ? dot : undefined) ??
    (typeof nested?.import === "string" ? nested.import : undefined) ??
    (typeof nested?.default === "string" ? nested.default : undefined) ??
    (typeof packageJson.module === "string" ? packageJson.module : undefined) ??
    (typeof packageJson.main === "string" ? packageJson.main : undefined);
  if (entry === undefined)
    throw new Error("@electron/fuses package entry was not a file path");
  const href = pathToFileURL(
    join(prefix, "node_modules", "@electron", "fuses", entry),
  ).href;
  const api = await import(href);
  return { version: packageJson.version, api };
};

const root = await mkdtemp(join(tmpdir(), "rea-release-exposure-"));
try {
  const beforeApp = join(root, "before", "MyApp.app");
  const afterApp = join(root, "after", "MyApp.app");
  const enabled = [0x31, 0x31, 0x31, 0x31, 0x30, 0x30];
  await writeApp(beforeApp, { withMap: true, states: enabled });
  await writeApp(afterApp, { withMap: false, states: enabled });
  const { version, api } = await installFuses(root);
  const { flipFuses, FuseVersion, FuseV1Options } = api;
  await flipFuses(
    join(
      afterApp,
      "Contents",
      "Frameworks",
      "Electron Framework.framework",
      "Electron Framework",
    ),
    {
      version: FuseVersion.V1,
      resetAdHocDarwinSignature: false,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    },
  );
  const gated = await audit(beforeApp, ["--fail_on", "high"]);
  if (gated.status !== 3)
    throw new Error(
      `--fail_on high exited ${String(gated.status)}, expected 3`,
    );
  const before = await audit(beforeApp);
  const after = await audit(afterApp);
  if (
    before.stdout.includes(PLANTED_SOURCE) ||
    after.stdout.includes(PLANTED_SOURCE) ||
    gated.stdout.includes(PLANTED_SOURCE)
  )
    throw new Error("Planted source text was copied into the audit report");
  const beforeChecks = checksOf(before.stdout);
  const afterChecks = checksOf(after.stdout);
  for (const id of [
    "javascript.source_map_sources",
    "packaging.extractable_payload",
    "electron.run_as_node",
    "electron.node_cli_inspect",
    "electron.only_load_from_asar",
  ])
    expectStatus("before", beforeChecks, id, "exposed");
  expectStatus("before", beforeChecks, "electron.asar_integrity", "unknown");
  expectStatus("before", beforeChecks, "go.build_paths", "unknown");
  expectStatus("before", beforeChecks, "rust.dependency_metadata", "unknown");
  expectStatus(
    "after",
    afterChecks,
    "javascript.source_map_sources",
    "not_observed",
  );
  expectStatus("after", afterChecks, "javascript.source_maps", "not_observed");
  expectStatus("after", afterChecks, "electron.run_as_node", "not_observed");
  expectStatus(
    "after",
    afterChecks,
    "electron.node_cli_inspect",
    "not_observed",
  );
  expectStatus(
    "after",
    afterChecks,
    "electron.only_load_from_asar",
    "not_observed",
  );
  expectStatus("after", afterChecks, "electron.asar_integrity", "unknown");
  expectStatus(
    "after",
    afterChecks,
    "packaging.extractable_payload",
    "exposed",
  );
  expectStatus("after", afterChecks, "go.build_paths", "unknown");
  expectStatus("after", afterChecks, "rust.dependency_metadata", "unknown");
  const document = `# Release exposure verification 2026-10-31

Ran \`node scripts/verify-release-exposure.mjs\` with Node ${process.version}. The package script is \`npm run verify:release-exposure\`, which runs \`npm run build:cached\` first because \`scripts/rea.mjs\` loads the compiled CLI. \`@electron/fuses\` ${version} was installed into a temporary prefix and \`flipFuses\` was called on the after framework binary.

The fixture is \`MyApp.app\`. \`Contents/Resources/app.asar\` holds \`app.js\`. Before, it also holds \`app.js.map\` with \`sourcesContent\`. \`Contents/Frameworks/Electron Framework.framework/Electron Framework\` is an ELF larger than 256 KiB with the Electron fuse sentinel and a version-1 fuse wire. After, the archive is rebuilt without the map and \`flipFuses\` disables \`RunAsNode\` and \`EnableNodeCliInspectArguments\` and enables \`OnlyLoadAppFromAsar\` and \`EnableEmbeddedAsarIntegrityValidation\`. \`app.js\` remains, so \`packaging.extractable_payload\` stays exposed. Embedded ASAR integrity stays \`unknown\` on ELF. Go and Rust stay \`unknown\` because the framework binary is registered and has no build metadata; that is not \`not_applicable\`.

\`--fail_on high\` on the before app exited ${String(gated.status)}.

## Before

${table(beforeChecks)}

## After

${table(afterChecks)}

\`javascript.source_map_sources\`, \`electron.run_as_node\`, \`electron.node_cli_inspect\`, and \`electron.only_load_from_asar\` changed from \`exposed\` to \`not_observed\`. \`electron.asar_integrity\` stayed \`unknown\`. \`packaging.extractable_payload\` stayed \`exposed\`.
`;
  await writeFile(OUTPUT, document);
  console.log(`wrote ${OUTPUT}`);
  console.log(`node ${process.version}`);
  console.log(`@electron/fuses ${version}`);
  console.log(`fail_on high exit ${String(gated.status)}`);
} finally {
  await rm(root, { recursive: true, force: true });
}
