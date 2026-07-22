#!/usr/bin/env node

import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { parseBinaryTarget } from "../dist/domain/binaryTarget.js";
import { resolveGhidraAnalysisProfile } from "../dist/ghidra/GhidraAnalysisProfile.js";
import { GhidraClient } from "../dist/ghidra/GhidraClient.js";
import { GHIDRA_DECOMPILE_REQUEST_TIMEOUT_MS } from "../dist/ghidra/GhidraDefaults.js";
import {
  inspectGhidraInstallation,
  SUPPORTED_GHIDRA_VERSION,
} from "../dist/ghidra/GhidraInstallation.js";
import { GhidraHeadlessLauncher } from "../dist/ghidra/GhidraLauncher.js";
import { GHIDRA_PROVIDER_IDENTITY } from "../dist/ghidra/GhidraProvider.js";

import {
  assertCleanup,
  assertCrossFixture,
  assertDebugFixture,
  assertMalformedFixture,
  assertRuntimeCoordinates,
  assertSession,
  assertStrippedFixture,
  summary,
} from "./verify-real-ghidra-assertions.mjs";
import {
  allItems,
  call,
  verifyInventoryOperations,
} from "./verify-real-ghidra-inventory.mjs";
import { completeVerifierRun, createVerifierRun } from "./lib/verifier-run.mjs";

const exec = promisify(execFile);
const verifierRun = createVerifierRun();
const installDir = process.env.GHIDRA_INSTALL_DIR;
if (installDir === undefined || !isAbsolute(installDir))
  throw new Error(
    "Set GHIDRA_INSTALL_DIR to the absolute root of an extracted Ghidra 12.1.2 release.",
  );
const installation = inspectGhidraInstallation({
  installDir,
  ...(process.env.JAVA_HOME === undefined
    ? {}
    : { javaHome: process.env.JAVA_HOME }),
});
if (!installation.available || installation.analyzeHeadlessPath === null)
  throw new Error(
    `Ghidra installation is unavailable: ${JSON.stringify(installation)}`,
  );
if (installation.providerVersion !== SUPPORTED_GHIDRA_VERSION)
  throw new Error("Ghidra provider version commitment drifted");

const fixtureRoot = await mkdtemp(join(tmpdir(), "rea-ghidra-fixtures-"));
const sourcePath = fileURLToPath(
  new URL("../tests/conformance/ghidra/inventory.c", import.meta.url),
);
const crossFormatSourcePath = fileURLToPath(
  new URL("../tests/conformance/ghidra/cross-format.c", import.meta.url),
);
const debugPath = join(fixtureRoot, "rea-ghidra-inventory-debug");
const strippedPath = join(fixtureRoot, "rea-ghidra-inventory-stripped");
const arm64ElfPath = join(fixtureRoot, "rea-ghidra-cross-arm64");
const peObjectPath = join(fixtureRoot, "rea-ghidra-cross-x86_64.obj");
const pePath = join(fixtureRoot, "rea-ghidra-cross-x86_64.exe");
const peImportLibraryPath = join(fixtureRoot, "rea-ghidra-cross-x86_64.lib");
const machObjectPath = join(fixtureRoot, "rea-ghidra-cross-x86_64.o");
const malformedPath = join(fixtureRoot, "rea-ghidra-malformed");
const compiler = process.env.REA_CC ?? "cc";
const clang = process.env.REA_CLANG ?? "clang";
const lldLink = process.env.REA_LLD_LINK ?? "lld-link";
try {
  const common = ["-O0", "-g", "-fno-inline", "-fno-pie", "-no-pie"];
  await exec(compiler, [...common, sourcePath, "-o", debugPath]);
  await exec(compiler, [...common, "-s", sourcePath, "-o", strippedPath]);
  await exec(clang, [
    "--target=aarch64-linux-gnu",
    "-O0",
    "-g",
    "-fno-inline",
    "-fno-pie",
    "-nostdlib",
    "-static",
    "-fuse-ld=lld",
    crossFormatSourcePath,
    "-Wl,-e,rea_cross_start",
    "-o",
    arm64ElfPath,
  ]);
  await exec(clang, [
    "--target=x86_64-pc-windows-msvc",
    "-O0",
    "-gcodeview",
    "-fno-inline",
    "-c",
    crossFormatSourcePath,
    "-o",
    peObjectPath,
  ]);
  await exec(lldLink, [
    "/entry:rea_cross_start",
    "/subsystem:console",
    "/nodefaultlib",
    "/export:rea_cross_entry",
    `/implib:${peImportLibraryPath}`,
    `/out:${pePath}`,
    peObjectPath,
  ]);
  await exec(clang, [
    "--target=x86_64-apple-darwin",
    "-O0",
    "-g",
    "-fno-inline",
    "-c",
    crossFormatSourcePath,
    "-o",
    machObjectPath,
  ]);
  await writeFile(malformedPath, Buffer.from("not-a-binary\n", "utf8"));

  const debug = await verifyTarget(debugPath, "debug", {
    format: "elf",
    architecture: "x86_64",
  });
  const stripped = await verifyTarget(strippedPath, "stripped", {
    format: "elf",
    architecture: "x86_64",
  });
  const arm64Elf = await verifyTarget(arm64ElfPath, "cross-arm64-elf", {
    format: "elf",
    architecture: "arm64",
  });
  const pe = await verifyTarget(pePath, "cross-x86_64-pe", {
    format: "pe",
    architecture: "x86_64",
  });
  const machObject = await verifyTarget(machObjectPath, "cross-x86_64-mach-o", {
    format: "mach-o",
    architecture: "x86_64",
  });
  assertDebugFixture(debug);
  assertStrippedFixture(stripped);
  for (const fixture of [arm64Elf, pe, machObject]) assertCrossFixture(fixture);
  await assertMalformedFixture(malformedPath);

  const customPath = process.env.GHIDRA_TARGET_PATH;
  const custom =
    customPath === undefined ? null : await verifyTarget(customPath, "custom");
  process.stdout.write(
    `${JSON.stringify({
      verifier_run: await completeVerifierRun(verifierRun),
      ok: true,
      provider: { id: "ghidra", version: SUPPORTED_GHIDRA_VERSION },
      fixture_sources: [sourcePath, crossFormatSourcePath],
      fixtures: [
        summary(debug),
        summary(stripped),
        summary(arm64Elf),
        summary(pe),
        summary(machObject),
      ],
      malformed_target: "rejected-before-provider-start",
      custom_target: custom === null ? null : summary(custom),
      cleanup: "complete",
    })}\n`,
  );
} finally {
  await rm(fixtureRoot, { recursive: true, force: true });
}

async function verifyTarget(targetPath, variant, expectedTarget = null) {
  const parsedTarget = await parseBinaryTarget(targetPath);
  if (!parsedTarget.ok) throw parsedTarget.error;
  if (
    expectedTarget !== null &&
    (parsedTarget.value.format !== expectedTarget.format ||
      parsedTarget.value.architecture !== expectedTarget.architecture)
  )
    throw new Error(
      `Fixture header classification drifted for ${variant}: ${JSON.stringify(parsedTarget.value)}`,
    );
  const profile = await resolveGhidraAnalysisProfile(
    parsedTarget.value,
    GHIDRA_PROVIDER_IDENTITY,
    installation,
  );
  if (!profile.ok || profile.value.profile === null)
    throw new Error("Ghidra analysis profile could not be committed");

  const client = new GhidraClient({
    launcher: new GhidraHeadlessLauncher({
      analyzeHeadlessPath: installation.analyzeHeadlessPath,
      ...(process.env.JAVA_HOME === undefined
        ? {}
        : { javaHome: process.env.JAVA_HOME }),
      bridgeScriptPath: fileURLToPath(
        new URL("../bridge/ghidra/ReaGhidraBridge.java", import.meta.url),
      ),
      platform: installation.platform,
    }),
    targetPath: parsedTarget.value.path,
    targetSha256: parsedTarget.value.sha256,
    providerVersion: SUPPORTED_GHIDRA_VERSION,
    profileDigest: profile.value.profile.digest,
    requestTimeoutMs: GHIDRA_DECOMPILE_REQUEST_TIMEOUT_MS,
  });

  let runtimeCoordinates;
  try {
    const started = await client.start();
    if (!started.ok) throw started.error;
    assertSession(
      started.value,
      profile.value.profile.digest,
      parsedTarget.value.sha256,
    );
    const pinged = await client.ping();
    if (!pinged.ok) throw pinged.error;
    assertSession(
      pinged.value,
      profile.value.profile.digest,
      parsedTarget.value.sha256,
    );
    runtimeCoordinates = client.diagnostics();
    assertRuntimeCoordinates(runtimeCoordinates);

    const documents = await call(client, "list_documents", {});
    const segments = await call(client, "list_segments", { document: null });
    const procedures = await allItems(client, "list_procedures", {
      document: null,
    });
    const names = await allItems(client, "list_names", {
      document: null,
      address: null,
    });
    const strings = await allItems(client, "list_strings", {
      document: null,
      address: null,
    });
    const probes =
      variant === "custom"
        ? null
        : await verifyInventoryOperations({
            client,
            variant,
            procedures,
            names,
            strings,
          });
    return {
      variant,
      target: parsedTarget.value,
      profile: profile.value.profile,
      session: pinged.value,
      documents,
      segments,
      procedures,
      names,
      strings,
      probes,
    };
  } finally {
    await client.close();
    if (runtimeCoordinates !== undefined)
      await assertCleanup(runtimeCoordinates);
  }
}
