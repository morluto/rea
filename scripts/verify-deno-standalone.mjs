#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { importVerifierSource } from "./lib/verifier-source-loader.mjs";
import { withVerifierCleanup } from "./lib/verifier-cleanup.mjs";
import { createVerifierCommands } from "./lib/verify-commands.mjs";

/** Layout reference in docs/deno-standalone.md. Not "whatever deno is on PATH". */
const REQUIRED_DENO_VERSION = "2.9.8";
const execFileAsync = promisify(execFile);

// Reject a different Deno release before the verifier source graph loads.
const version = (
  await execFileAsync("deno", ["--version"], { encoding: "utf8" })
).stdout.trim();
const reported = /^deno (\d+\.\d+\.\d+)/m.exec(version);
if (reported?.[1] !== REQUIRED_DENO_VERSION)
  throw new Error(
    `verify-deno-standalone requires Deno ${REQUIRED_DENO_VERSION}; deno --version reported:\n${version}`,
  );

const { PrivateRuntimeRoot } = await importVerifierSource(
  new URL("../src/process/PrivateRuntimeRoot.ts", import.meta.url).href,
  import.meta.url,
);
const { parseEvidence } = await importVerifierSource(
  new URL("../src/domain/evidence.ts", import.meta.url).href,
  import.meta.url,
);

const secret = "super-secret-value";
// 243 bytes fits NAME_MAX, and its `.deno-transpiled` child path does not.
const longModule = `${"l".repeat(240)}.ts`;
const longModuleText = 'export const long: string = "long";\n';
const sourceText = `import text from "./asset.txt" with { type: "text" };\nimport { long } from "./${longModule}";\nconsole.log(text, long);\n`;
const assetText = "hello-asset\n";
const HOST_CARRIERS = { darwin: "mach-o", linux: "elf", win32: "pe" };
const root = await PrivateRuntimeRoot.create({ prefix: "rea-deno-verifier-" });
const commands = await createVerifierCommands();
const run = (command, args, options = {}) =>
  commands.exec(command, args, {
    timeout: 300_000,
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  });
let commandsClosed = false;

const cli = async (binary) =>
  JSON.parse(
    (
      await run(process.execPath, ["scripts/rea.mjs", ...binary], {
        env: {
          ...process.env,
          TMPDIR: root.path,
          TMP: root.path,
          TEMP: root.path,
        },
      })
    ).stdout,
  );

const inventoryOf = (inspected) => {
  const graph = parseEvidence(inspected).normalized_result.substeps.find(
    (step) => step.operation === "inventory_artifact",
  )?.evidence.normalized_result;
  assert.ok(graph, "inspect-artifact did not include an inventory substep");
  return graph;
};

const producedBinary = async (binary) => {
  try {
    await access(binary);
    return binary;
  } catch {
    const exe = `${binary}.exe`;
    await access(exe);
    return exe;
  }
};

const member = (graph, suffix) =>
  graph.occurrences.find(
    (row) =>
      row.format_metadata?.kind === "deno-standalone-entry" &&
      row.format_metadata.role === "vfs-file" &&
      (row.logical_path === suffix ||
        row.logical_path.endsWith(`/${suffix}`) ||
        row.format_metadata.source_path === suffix ||
        row.format_metadata.source_path?.endsWith(`/${suffix}`)),
  );

await withVerifierCleanup(async () => {
  const app = join(root.path, "main.ts");
  const asset = join(root.path, "asset.txt");
  const envFile = join(root.path, "app.env");
  await writeFile(app, sourceText);
  await writeFile(asset, assetText);
  await writeFile(join(root.path, longModule), longModuleText);
  await writeFile(envFile, `REA_DENO_TOKEN=${secret}\n`);
  const hostBinary = join(root.path, "app-host");
  await run("deno", [
    "compile",
    `--env-file=${envFile}`,
    "--self-extracting",
    "--no-check",
    "--output",
    hostBinary,
    app,
  ]);
  const hostOutput = await producedBinary(hostBinary);
  const inspectedText = JSON.stringify(
    await cli(["inspect-artifact", hostOutput, "--json"]),
  );
  assert.ok(inspectedText.includes(secret));
  const graph = inventoryOf(JSON.parse(inspectedText));
  assert.equal(graph.manifest.root_format, "deno-standalone");
  const rootMetadata = graph.occurrences.find(
    (row) => row.logical_path === ".",
  )?.format_metadata;
  assert.equal(rootMetadata?.kind, "deno-standalone");
  assert.equal(rootMetadata.carrier, HOST_CARRIERS[process.platform]);
  assert.equal(rootMetadata.entrypoint_key, "main.ts");
  assert.equal(rootMetadata.vfs_listing, "listed");
  assert.equal(typeof rootMetadata.npm_snapshot_byte_length, "number");
  assert.equal(rootMetadata.env_var_count, 1);
  assert.deepEqual(rootMetadata.env_vars, [
    {
      name: "REA_DENO_TOKEN",
      value: secret,
      value_byte_length: Buffer.byteLength(secret),
    },
  ]);
  assert.equal(typeof rootMetadata.self_extracting, "string");
  assert.ok(rootMetadata.self_extracting.length > 0);
  const main = member(graph, "main.ts");
  const storedAsset = member(graph, "asset.txt");
  assert.ok(main, "virtual filesystem has no main.ts file");
  assert.ok(storedAsset, "virtual filesystem has no asset.txt file");
  const long = member(graph, longModule);
  assert.ok(long, "virtual filesystem has no long-named module");
  assert.match(long.logical_path, /^deno-vfs\/\d+$/u);
  const extracted = parseEvidence(
    await cli(["extract-artifact", hostOutput, "--json"]),
  ).normalized_result;
  assert.equal(extracted.containment_verified, true);
  assert.equal(
    await readFile(join(extracted.output_root, main.logical_path), "utf8"),
    sourceText,
  );
  assert.equal(
    await readFile(
      join(extracted.output_root, storedAsset.logical_path),
      "utf8",
    ),
    assetText,
  );
  assert.equal(
    await readFile(join(extracted.output_root, long.logical_path), "utf8"),
    longModuleText,
  );
  const transpiledLong = await readFile(
    join(extracted.output_root, `${long.logical_path}.deno-transpiled`),
    "utf8",
  );
  assert.ok(transpiledLong.includes("long"));
  let nativeElfRootFormat;
  const crosses = [];
  for (const [target, carrier] of [
    ["x86_64-unknown-linux-gnu", "elf"],
    ["x86_64-pc-windows-msvc", "pe"],
    ["x86_64-apple-darwin", "mach-o"],
  ]) {
    const binary = join(root.path, `app-${target}`);
    let output;
    try {
      await run("deno", [
        "compile",
        "--target",
        target,
        "--no-check",
        "--output",
        binary,
        app,
      ]);
      output = await producedBinary(binary);
    } catch (cause) {
      crosses.push({
        target,
        expected_carrier: carrier,
        error: cause instanceof Error ? cause.message : String(cause),
      });
      continue;
    }
    const crossGraph = inventoryOf(
      await cli(["inspect-artifact", output, "--json"]),
    );
    assert.equal(crossGraph.manifest.root_format, "deno-standalone");
    const metadata = crossGraph.occurrences.find(
      (row) => row.logical_path === ".",
    )?.format_metadata;
    assert.equal(metadata?.carrier, carrier);
    const crossMain = member(crossGraph, "main.ts");
    const crossAsset = member(crossGraph, "asset.txt");
    assert.ok(crossMain);
    assert.ok(crossAsset);
    const crossExtracted = parseEvidence(
      await cli(["extract-artifact", output, "--json"]),
    ).normalized_result;
    assert.equal(
      await readFile(
        join(crossExtracted.output_root, crossMain.logical_path),
        "utf8",
      ),
      sourceText,
    );
    assert.equal(
      await readFile(
        join(crossExtracted.output_root, crossAsset.logical_path),
        "utf8",
      ),
      assetText,
    );
    if (carrier === "elf") {
      // An unparseable note table with no confirmed SUI note stays native.
      const image = await readFile(output);
      const owner = metadata.section_offset - "d3n0l4nd".length - 2 - 4;
      assert.equal(image.toString("latin1", owner, owner + 3), "SUI");
      image.writeUInt32LE(0x7fffffff, owner - 12);
      const damaged = join(root.path, "damaged-native-elf");
      await writeFile(damaged, image);
      nativeElfRootFormat = inventoryOf(
        await cli(["inspect-artifact", damaged, "--json"]),
      ).manifest.root_format;
      assert.notEqual(nativeElfRootFormat, "deno-standalone");
    }
    crosses.push({
      target,
      carrier: metadata.carrier,
      embedding: metadata.embedding,
      extracted: true,
    });
  }
  console.log(
    JSON.stringify(
      {
        deno: version,
        host: `${process.platform}-${process.arch}`,
        root_format: graph.manifest.root_format,
        carrier: rootMetadata.carrier,
        embedding: rootMetadata.embedding,
        entrypoint_key: rootMetadata.entrypoint_key,
        env_var: rootMetadata.env_vars[0],
        env_value_retained_in_inspect_json: true,
        npm_snapshot_byte_length: rootMetadata.npm_snapshot_byte_length,
        self_extracting_recorded: true,
        main_logical_path: main.logical_path,
        asset_logical_path: storedAsset.logical_path,
        long_module_logical_path: long.logical_path,
        long_module_source_bytes: Buffer.byteLength(longModule),
        damaged_native_elf_root_format: nativeElfRootFormat,
        extraction_verified: true,
        target_executed: false,
        crosses,
      },
      null,
      2,
    ),
  );
}, [
  async () => {
    await commands.close();
    commandsClosed = true;
  },
  async () => {
    if (commandsClosed) await root.close();
  },
]);
