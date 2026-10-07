import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";

/** Prove cold metadata stays unmaterialized and overload identities survive code generation. */
export const verifyAndroidMetadata = async ({
  java,
  jar,
  apk,
  bridge,
  repository,
  execute,
}) => {
  const javac =
    process.env.JAVA_HOME === undefined
      ? "javac"
      : resolve(process.env.JAVA_HOME, "bin/javac");
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
        "-classpath",
        `${classes}${delimiter}${jar}`,
        "ReaJadxMetadataRegression",
        apk,
      ],
      { timeout: 120_000, maxBuffer: 8 * 1024 * 1024 },
    );
    assert.match(
      result.stdout,
      /METADATA_REGRESSION_PASS classes=\d+ overloads=3/u,
    );
    console.log(
      "PASS real cold metadata, full generic types and stable overloaded method selection",
    );
  } finally {
    await rm(classes, { recursive: true, force: true });
  }
};
