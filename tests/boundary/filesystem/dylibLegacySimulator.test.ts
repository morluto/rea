import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, it } from "vitest";

import { traceDylibResolution } from "../../../src/artifacts/apple/DylibResolutionReader.js";
import { execFileOutput } from "../../../src/process/ExecFileOutput.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

it.skipIf(process.platform !== "darwin")(
  "resolves an Apple-linked modern simulator dylib from a legacy simulator executable",
  async () => {
    const root = await createTestTempDirectory("rea-legacy-simulator-");
    const native = async (arguments_: string[]) =>
      execFileOutput("/usr/bin/xcrun", arguments_, {
        timeout: 10_000,
        maxBuffer: 1024 * 1024,
      });
    // Xcode's real simulator SDK and linker establish the platform meaning;
    // neither fixture is executed or loaded into this process.
    const sdk = (
      await native(["--sdk", "iphonesimulator", "--show-sdk-path"])
    ).stdout.trim();
    await writeFile(
      join(root, "library.c"),
      "int fixture(void) { return 7; }\n",
    );
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
    expect(
      (await native(["vtool", "-show-build", executable])).stdout,
    ).toContain("LC_VERSION_MIN_IPHONEOS");
    expect(
      (await native(["vtool", "-show-build", join(root, "libFixture.dylib")]))
        .stdout,
    ).toContain("IOSSIMULATOR");
    const trace = await traceDylibResolution({
      rootPath: root,
      targetPath: executable,
      targetSha256: createHash("sha256")
        .update(await readFile(executable))
        .digest("hex"),
      enumerateRoots: false,
      parameters: {},
    });
    expect(
      trace.edges.find(
        ({ install_name }) => install_name === "@rpath/libFixture.dylib",
      )?.resolution,
    ).toEqual({ status: "resolved", image: "libFixture.dylib" });
    expect(
      trace.images.find(({ path }) => path === "Main")?.slices[0],
    ).toMatchObject({
      platform: 7,
      platforms: [7],
    });
  },
);
