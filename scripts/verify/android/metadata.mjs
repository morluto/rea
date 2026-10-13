import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { verifyAndroidInitializers } from "./initializers.mjs";
import { verifyAndroidDirectInvokes } from "./direct-invokes.mjs";

/** Prove cold metadata stays unmaterialized and overload identities survive code generation. */
export const verifyAndroidMetadata = async ({
  java,
  jar,
  apk,
  bridge,
  repository,
  execute,
  entrypoint,
  environment,
  jvmArguments = [],
}) => {
  const javac =
    process.env.JAVA_HOME === undefined
      ? "javac"
      : resolve(
          process.env.JAVA_HOME,
          "bin",
          process.platform === "win32" ? "javac.exe" : "javac",
        );
  try {
    await execute(javac, ["-version"], { timeout: 10_000 });
  } catch (cause) {
    throw new Error(
      "verify:android metadata requires the full selected JDK, including javac",
      { cause },
    );
  }
  const classes = await mkdtemp(join(tmpdir(), "rea-android-metadata-"));
  try {
    await execute(
      javac,
      [
        ...jvmArguments.map((argument) => `-J${argument}`),
        "-classpath",
        jar,
        "-d",
        classes,
        bridge,
        resolve(
          repository,
          "tests/conformance/android/ReaJadxMetadataRegression.java",
        ),
      ],
      { timeout: 30_000 },
    );
    const result = await execute(
      java,
      [
        ...jvmArguments,
        "-classpath",
        `${classes}${delimiter}${jar}`,
        "ReaJadxMetadataRegression",
        apk,
        resolve(repository, "tests/fixtures/android/static-initializers"),
        classes,
        resolve(repository, "tests/fixtures/android/direct-invokes"),
      ],
      { timeout: 120_000, maxBuffer: 8 * 1024 * 1024 },
    );
    assert.match(
      result.stdout,
      /METADATA_REGRESSION_PASS classes=\d+ overloads=3/u,
    );
    assert.match(
      result.stdout,
      /INITIALIZER_REGRESSION_PASS folded=2 bounded=true/u,
    );
    assert.match(
      result.stdout,
      /DIRECT_INVOKE_REGRESSION_PASS nodes=1 offsets=0,3 cross_dex=true/u,
    );
    console.log(
      "PASS real cold metadata, full generic types and stable overloaded method selection",
    );
    console.log(
      "PASS real folded and mixed static initializers, absent bodies and bounded smali",
    );
    console.log(
      "PASS real raw DEX direct-invoke offsets and cross-DEX source identity",
    );
    await verifyAndroidInitializers({
      apk: resolve(classes, "initializers.apk"),
      repository,
      entrypoint,
      environment,
      execute,
    });
    await verifyAndroidDirectInvokes({
      apk: resolve(classes, "direct-invokes.apk"),
      dexEntry: "classes.dex",
      repository,
      entrypoint,
      environment,
      execute,
    });
    await verifyAndroidDirectInvokes({
      apk: resolve(classes, "direct-invokes-multidex.apk"),
      dexEntry: "classes2.dex",
      repository,
      entrypoint,
      environment,
      execute,
    });
  } finally {
    await rm(classes, { recursive: true, force: true });
  }
};
