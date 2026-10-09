import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { promisify } from "node:util";

import { traceDylibResolution } from "../../../dist/artifacts/apple/DylibResolutionReader.js";

const exec = promisify(execFile);
assert.equal(
  process.platform,
  "darwin",
  "Legacy simulator verification requires a macOS host with full Xcode.",
);
try {
  for (const tool of ["clang", "ld", "vtool"])
    await exec("/usr/bin/xcrun", ["--find", tool], { timeout: 10_000 });
  await exec(
    "/usr/bin/xcrun",
    ["--sdk", "iphonesimulator", "--show-sdk-path"],
    { timeout: 10_000 },
  );
} catch (cause) {
  throw new Error(
    "Legacy simulator verification requires full Xcode with the iPhone Simulator SDK and clang, ld, vtool. Select its developer directory using xcode-select.",
    { cause },
  );
}
console.log("Verified full Xcode simulator SDK and linker prerequisites.");
const root = await mkdtemp(join(tmpdir(), "rea-legacy-simulator-"));
try {
  const native = async (arguments_) =>
    exec("/usr/bin/xcrun", arguments_, {
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    });
  // Xcode's real simulator SDK and linker establish the platform meaning;
  // neither fixture is executed or loaded into this process.
  const sdk = (
    await native(["--sdk", "iphonesimulator", "--show-sdk-path"])
  ).stdout.trim();
  await writeFile(join(root, "library.c"), "int fixture(void) { return 7; }\n");
  await writeFile(
    join(root, "main.c"),
    "extern int fixture(void); int main(void) { return fixture(); }\n",
  );
  for (const [source, deployment] of [
    ["library", "14.0"],
    ["main", "9.0"],
  ]) {
    await native([
      "clang",
      "-target",
      `x86_64-apple-ios${deployment}-simulator`,
      "-isysroot",
      sdk,
      "-c",
      join(root, `${source}.c`),
      "-o",
      join(root, `${source}.o`),
    ]);
  }
  const common = ["ld", "-arch", "x86_64", "-syslibroot", sdk, "-lSystem"];
  await native([
    ...common,
    "-dylib",
    "-platform_version",
    "ios-simulator",
    "14.0",
    "14.0",
    "-install_name",
    "@rpath/libFixture.dylib",
    join(root, "library.o"),
    "-o",
    join(root, "libFixture.dylib"),
  ]);
  const executable = join(root, "Main");
  await native([
    ...common,
    "-platform_version",
    "ios-simulator",
    "9.0",
    "14.0",
    "-e",
    "_main",
    "-rpath",
    "@loader_path",
    join(root, "main.o"),
    join(root, "libFixture.dylib"),
    "-o",
    executable,
  ]);
  assert.match(
    (await native(["vtool", "-show-build", executable])).stdout,
    /LC_VERSION_MIN_IPHONEOS/u,
  );
  assert.match(
    (await native(["vtool", "-show-build", join(root, "libFixture.dylib")]))
      .stdout,
    /IOSSIMULATOR/u,
  );
  const trace = await traceDylibResolution({
    rootPath: root,
    targetPath: executable,
    targetSha256: createHash("sha256")
      .update(await readFile(executable))
      .digest("hex"),
    enumerateRoots: false,
    parameters: {},
  });
  assert.deepEqual(
    trace.edges.find(
      ({ install_name }) => install_name === "@rpath/libFixture.dylib",
    )?.resolution,
    { status: "resolved", image: "libFixture.dylib" },
  );
  const slice = trace.images.find(({ path }) => path === "Main")?.slices[0];
  assert.equal(slice?.platform, 7);
  assert.deepEqual(slice?.platforms, [7]);

  console.log(
    "Legacy simulator platform verification passed against Apple clang, ld and vtool.",
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
