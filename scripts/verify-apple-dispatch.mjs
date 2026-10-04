import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parseBinaryTarget } from "../dist/application/BinaryTargetResolver.js";
import { inspectAppleDispatchMetadata } from "../dist/native/AppleDispatchMetadata.js";

if (process.platform !== "darwin")
  throw new Error(
    "Apple dispatch verification requires macOS with a host Objective-C compiler and Foundation SDK",
  );
const exec = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), "rea-dispatch-"));
try {
  const targetPath = join(root, "fixture");
  await exec("/usr/bin/xcrun", [
    "clang",
    "-O2",
    "-framework",
    "Foundation",
    "-Wl,-no_fixup_chains",
    fileURLToPath(
      new URL("../tests/conformance/native/dispatch.m", import.meta.url),
    ),
    "-o",
    targetPath,
  ]);
  const results = [];
  for (const variant of ["symbols", "stripped"]) {
    if (variant === "stripped")
      await exec("/usr/bin/strip", ["-x", targetPath]);
    const target = await parseBinaryTarget(targetPath);
    if (!target.ok) throw target.error;
    const observation = await inspectAppleDispatchMetadata(target.value, 5000);
    const metadata = observation.result;
    if (
      !metadata.objc_dispatch_implementations.some(
        (item) =>
          item.class_name === "ReaDispatchFixture" &&
          item.selector === "performAction:" &&
          item.implementation_address !== null,
      ) ||
      !metadata.objc_dispatch_implementations.some(
        (item) =>
          item.selector === "fixtureVersion" && item.method_type === "class",
      ) ||
      !metadata.objc_ivars.some(
        (item) => item.name === "state" && item.offset !== null,
      ) ||
      !metadata.objc_protocol_records.some(
        (protocol) =>
          protocol.name === "ReaDispatchProtocol" &&
          protocol.methods.some(
            (method) => method.selector === "performAction:",
          ) &&
          protocol.optional_methods.some(
            (method) => method.selector === "optionalFixtureValue",
          ),
      )
    )
      throw new Error(
        `Apple metadata fixture drifted: ${JSON.stringify(observation)}`,
      );
    results.push({
      variant,
      target_sha256: target.value.sha256,
      implementations: metadata.objc_dispatch_implementations.length,
      ivars: metadata.objc_ivars.length,
      coverage: metadata.coverage,
    });
  }
  const swiftPath = join(root, "libReaWitnessFixture.dylib");
  await exec("/usr/bin/xcrun", [
    "swiftc",
    "-emit-library",
    "-O",
    "-Xlinker",
    "-no_fixup_chains",
    fileURLToPath(
      new URL("../tests/conformance/native/dispatch.swift", import.meta.url),
    ),
    "-o",
    swiftPath,
  ]);
  for (const variant of ["swift-symbols", "swift-stripped"]) {
    if (variant === "swift-stripped")
      await exec("/usr/bin/strip", ["-x", swiftPath]);
    const target = await parseBinaryTarget(swiftPath);
    if (!target.ok) throw target.error;
    const observation = await inspectAppleDispatchMetadata(target.value, 5000);
    const metadata = observation.result;
    if (
      !metadata.swift_dispatch_slots.some(
        (slot) =>
          slot.table_kind === "class_vtable" &&
          slot.owner === "ReaVtableFixture" &&
          slot.decode.status === "decoded",
      )
    )
      throw new Error(
        `Swift class vtable fixture unavailable: ${JSON.stringify(metadata.coverage)}`,
      );
    if (
      !metadata.swift_conformances.some(
        (item) =>
          item.type_name === "ReaWitnessFixture" &&
          item.protocol_name === "ReaWitnessFixtureProtocol",
      ) ||
      !metadata.swift_dispatch_slots.some(
        (item) =>
          item.owner === "ReaWitnessFixture: ReaWitnessFixtureProtocol" &&
          item.implementation_address !== null,
      )
    )
      throw new Error(
        `Swift metadata fixture drifted: ${JSON.stringify(observation)}`,
      );
    results.push({
      variant,
      target_sha256: target.value.sha256,
      conformances: metadata.swift_conformances.length,
      slots: metadata.swift_dispatch_slots.length,
      coverage: metadata.coverage,
    });
  }
  process.stdout.write(
    `${JSON.stringify({ ok: true, target_executed: false, fixtures: results })}\n`,
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
