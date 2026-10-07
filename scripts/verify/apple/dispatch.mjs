import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parseBinaryTarget } from "../../../dist/application/BinaryTargetResolver.js";
import { inspectAppleDispatchMetadata } from "../../../dist/native/AppleDispatchMetadata.js";

if (process.platform !== "darwin")
  throw new Error(
    "Apple dispatch verification requires macOS with a host Objective-C compiler and Foundation SDK",
  );
const exec = promisify(execFile);
const source = (name) =>
  fileURLToPath(
    new URL(`../../../tests/conformance/native/${name}`, import.meta.url),
  );

/** Both link modes: legacy LC_DYLD_INFO binds and the default chained fixups. */
const LINK_MODES = [
  {
    mode: "dyld-info",
    flags: ["-Wl,-no_fixup_chains"],
    fixups: "LC_DYLD_INFO bind opcodes",
    swift: true,
  },
  { mode: "chained", flags: [], fixups: "chained fixups:", swift: true },
  // arm64e uses authenticated chained pointers (DYLD_CHAINED_PTR_ARM64E_*).
  ...(process.arch === "arm64"
    ? [
        {
          mode: "chained-arm64e",
          flags: ["-arch", "arm64e"],
          fixups: "chained fixups: DYLD_CHAINED_PTR_ARM64E",
          swift: false,
        },
      ]
    : []),
];

const fixupCoverage = (metadata) =>
  metadata.coverage.find(({ facet }) => facet === "pointer_fixups");

const inspect = async (path) => {
  const target = await parseBinaryTarget(path);
  if (!target.ok) throw target.error;
  return {
    target: target.value,
    metadata: (await inspectAppleDispatchMetadata(target.value, 5000)).result,
  };
};

const checkObjc = (metadata, mode) => {
  const fixture = metadata.objc_classes.find(
    ({ name, is_meta_class: meta }) => name === "ReaDispatchFixture" && !meta,
  );
  const category = metadata.objc_categories.find(
    ({ name }) => name === "ReaDispatchAdditions",
  );
  const objcCoverage = metadata.coverage.find(
    ({ facet }) => facet === "objc_class_method_ivar_metadata",
  );
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
    ) ||
    // The superclass lives in libobjc, so it comes from a bind fixup.
    fixture?.super_class !== "NSObject" ||
    fixture.decode.status !== "decoded" ||
    !fixture.properties.some(
      (property) =>
        property.name === "fixtureName" &&
        property.type_encoding === '@"NSString"' &&
        property.attributes.some(({ name }) => name === "C"),
    ) ||
    category?.class_name !== "NSString" ||
    category.class_source !== "external" ||
    !category.instance_methods.includes("reaFixtureLength") ||
    !metadata.objc_dispatch_implementations.some(
      (item) =>
        item.class_name === "NSString" &&
        item.category === "ReaDispatchAdditions" &&
        item.selector === "reaFixtureLength",
    ) ||
    objcCoverage?.status !== "complete" ||
    fixupCoverage(metadata)?.reason?.startsWith(mode.fixups) !== true
  )
    throw new Error(
      `Apple metadata fixture drifted (${mode.mode}): ${JSON.stringify(metadata)}`,
    );
};

const checkSwift = (metadata, mode) => {
  if (
    !metadata.swift_dispatch_slots.some(
      (slot) =>
        slot.table_kind === "class_vtable" &&
        slot.owner === "ReaVtableFixture" &&
        slot.decode.status === "decoded",
    )
  )
    throw new Error(
      `Swift class vtable fixture unavailable (${mode.mode}): ${JSON.stringify(metadata.coverage)}`,
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
    ) ||
    fixupCoverage(metadata)?.reason?.startsWith(mode.fixups) !== true
  )
    throw new Error(
      `Swift metadata fixture drifted (${mode.mode}): ${JSON.stringify(metadata)}`,
    );
};

const root = await mkdtemp(join(tmpdir(), "rea-dispatch-"));
try {
  const results = [];
  for (const mode of LINK_MODES) {
    const objcPath = join(root, `fixture-${mode.mode}`);
    await exec("/usr/bin/xcrun", [
      "clang",
      "-O2",
      "-framework",
      "Foundation",
      ...mode.flags,
      source("dispatch.m"),
      "-o",
      objcPath,
    ]);
    for (const variant of ["symbols", "stripped"]) {
      if (variant === "stripped")
        await exec("/usr/bin/strip", ["-x", objcPath]);
      const { target, metadata } = await inspect(objcPath);
      checkObjc(metadata, mode);
      results.push({
        variant: `objc-${mode.mode}-${variant}`,
        target_sha256: target.sha256,
        classes: metadata.objc_classes.length,
        categories: metadata.objc_categories.length,
        implementations: metadata.objc_dispatch_implementations.length,
        fixups: fixupCoverage(metadata)?.reason,
      });
    }
    if (!mode.swift) continue;
    const swiftPath = join(root, `libReaWitnessFixture-${mode.mode}.dylib`);
    await exec("/usr/bin/xcrun", [
      "swiftc",
      "-emit-library",
      "-O",
      ...mode.flags
        .map((flag) => flag.replace(/^-Wl,/u, "-Xlinker\0"))
        .flatMap((flag) => flag.split("\0")),
      source("dispatch.swift"),
      "-o",
      swiftPath,
    ]);
    for (const variant of ["symbols", "stripped"]) {
      if (variant === "stripped")
        await exec("/usr/bin/strip", ["-x", swiftPath]);
      const { target, metadata } = await inspect(swiftPath);
      checkSwift(metadata, mode);
      results.push({
        variant: `swift-${mode.mode}-${variant}`,
        target_sha256: target.sha256,
        conformances: metadata.swift_conformances.length,
        slots: metadata.swift_dispatch_slots.length,
        fixups: fixupCoverage(metadata)?.reason,
      });
    }
  }
  process.stdout.write(
    `${JSON.stringify({ ok: true, target_executed: false, fixtures: results })}\n`,
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
