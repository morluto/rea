import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, onTestFinished, test } from "vitest";

import { ApktoolProvider } from "./ApktoolProvider.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import type { ApktoolRequest } from "../domain/apktool/apktoolResourceAnalysis.js";

const it = test.skipIf(process.platform === "win32");

const VERSION_BLOCK = "printf '2.7.0-stub\\n'";

const REAL_YML = [
  "!!brut.androlib.meta.MetaInfo",
  "sdkInfo:",
  "  minSdkVersion: '24'",
  "  targetSdkVersion: '34'",
  "versionInfo:",
  "  versionCode: '7'",
  "  versionName: 1.2.3",
  "",
].join("\n");

const REAL_MANIFEST = [
  '<?xml version="1.0" encoding="utf-8" standalone="no"?>',
  '<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="com.rea.apktool.probe">',
  '    <application android:label="@string/app_name" android:debuggable="true"/>',
  "</manifest>",
  "",
].join("\n");

const REAL_STRINGS = [
  '<?xml version="1.0" encoding="utf-8"?>',
  "<resources>",
  '    <string name="api_endpoint">https://api.example.com/v1</string>',
  '    <string name="app_name">ApktoolProbe</string>',
  "</resources>",
  "",
].join("\n");

const DE_STRINGS = [
  '<?xml version="1.0" encoding="utf-8"?>',
  "<resources>",
  '    <string name="app_name">ApktoolProbe DE</string>',
  "</resources>",
  "",
].join("\n");

const writeApktoolStub = async (
  body: (root: string) => string,
): Promise<{ readonly command: string; readonly root: string }> => {
  const root = await mkdtemp(join("/tmp", "rea-apktool-stub-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const command = join(root, "apktool");
  await writeFile(command, `#!/bin/sh\n${body(root)}\n`, { mode: 0o755 });
  await chmod(command, 0o755);
  return { command, root };
};

const providerOver = (command: string): ApktoolProvider =>
  new ApktoolProvider({
    environment: { REA_APKTOOL_COMMAND: command },
  });

const evidenceResult = async (
  provider: ApktoolProvider,
  request: ApktoolRequest,
): Promise<Record<string, unknown>> => {
  const result = await provider.execute(request);
  if (!result.ok) throw new Error(result.error.message);
  return result.value.result as Record<string, unknown>;
};

const refusedBy = async (
  provider: ApktoolProvider,
  request: ApktoolRequest,
): Promise<ReturnType<typeof projectAnalysisError>> => {
  const result = await provider.execute(request);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected a refusal");
  return projectAnalysisError(result.error);
};

/** Stub writing a real-shaped decoded workspace into the -o directory. */
const decodeStub = (
  options: {
    readonly withStrings?: boolean;
    readonly withGerman?: boolean;
    readonly failDecode?: boolean;
  } = {},
): ((root: string) => string) => {
  const withStrings = options.withStrings ?? true;
  const withGerman = options.withGerman ?? true;
  return () => `if [ "$1" = "--version" ]; then ${VERSION_BLOCK}; exit 0; fi
if [ "$1" = "d" ]; then
  ${
    options.failDecode === true
      ? `printf 'Exception in thread "main" brut.androlib.AndrolibException: Could not decode the APK\\n' >&2; exit 1;`
      : `printf '%s\\n' '${REAL_YML.replace(/'/gu, "'\\''")}' > "$5/apktool.yml"
  printf '%s\\n' '${REAL_MANIFEST.replace(/'/gu, "'\\''")}' > "$5/AndroidManifest.xml"
  mkdir -p "$5/res/values"${withGerman ? ' "$5/res/values-de"' : ""}
  ${withStrings ? `printf '%s\\n' '${REAL_STRINGS.replace(/'/gu, "'\\''")}' > "$5/res/values/strings.xml"` : ""}
  ${withGerman ? `printf '%s\\n' '${DE_STRINGS.replace(/'/gu, "'\\''")}' > "$5/res/values-de/strings.xml"` : ""}
  printf 'I: Using Apktool on stub\\n'
  exit 0`
  }
fi
printf 'unexpected arguments: %s\\n' "$@"
exit 1`;
};

const apkFixture = async (
  root: string,
): Promise<{
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}> => {
  const path = join(root, "probe.apk");
  const bytes = "apk-bytes-for-apktool";
  await writeFile(path, bytes);
  return {
    path,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
};

it("inspects the apktool launcher", async () => {
  const { command } = await writeApktoolStub(
    () => `if [ "$1" = "--version" ]; then ${VERSION_BLOCK}; exit 0; fi`,
  );
  const result = await evidenceResult(providerOver(command), {
    operation: "inspect_apktool_client",
    input: {},
  });
  expect(result.client).toEqual({
    command,
    command_source: "environment",
    apktool_version: "2.7.0-stub",
  });
});

it("decodes resources with target identity, metadata, and strings", async () => {
  const { command, root } = await writeApktoolStub(decodeStub());
  const apk = await apkFixture(root);
  const result = await evidenceResult(providerOver(command), {
    operation: "decode_android_resources",
    input: { path: apk.path, include_strings: true },
  });
  expect(result.target).toEqual({
    path: apk.path,
    bytes: apk.bytes,
    sha256: apk.sha256,
  });
  expect(result.metadata).toEqual({
    version_name: "1.2.3",
    version_code: "7",
    min_sdk_version: "24",
    target_sdk_version: "34",
    package_name: "com.rea.apktool.probe",
  });
  expect(result.manifest).toContain('package="com.rea.apktool.probe"');
  expect(result.strings).toEqual([
    { name: "api_endpoint", value: "https://api.example.com/v1" },
    { name: "app_name", value: "ApktoolProbe" },
  ]);
  expect(result.locales).toEqual(["de"]);
  expect(result.locale).toBeNull();
  expect(result.decoded_file_count).toBeGreaterThan(2);
  expect(result.coverage).toBe("complete");
});

it("projects one locale's strings on request", async () => {
  const { command, root } = await writeApktoolStub(decodeStub());
  const apk = await apkFixture(root);
  const result = await evidenceResult(providerOver(command), {
    operation: "decode_android_resources",
    input: { path: apk.path, include_strings: true, locale: "de" },
  });
  expect(result.locale).toBe("de");
  expect(result.strings).toEqual([
    { name: "app_name", value: "ApktoolProbe DE" },
  ]);
});

it("notes a missing locale table instead of failing", async () => {
  const { command, root } = await writeApktoolStub(decodeStub());
  const apk = await apkFixture(root);
  const result = await evidenceResult(providerOver(command), {
    operation: "decode_android_resources",
    input: { path: apk.path, include_strings: true, locale: "fr" },
  });
  expect(result.strings).toEqual([]);
});

it("notes a missing default strings table without strings", async () => {
  const { command, root } = await writeApktoolStub(
    decodeStub({ withStrings: false }),
  );
  const apk = await apkFixture(root);
  const result = await evidenceResult(providerOver(command), {
    operation: "decode_android_resources",
    input: { path: apk.path, include_strings: true },
  });
  expect(result.strings).toEqual([]);
});

it("reports apktool's own refusal for undecodable targets", async () => {
  const { command, root } = await writeApktoolStub(
    decodeStub({ failDecode: true }),
  );
  const apk = await apkFixture(root);
  const projected = await refusedBy(providerOver(command), {
    operation: "decode_android_resources",
    input: { path: apk.path, include_strings: true },
  });
  expect(projected).toMatchObject({ code: "unsupported_target" });
  expect(projected.message).toContain("Could not decode");
});

it("reports a missing launcher as a capability gap with recovery", async () => {
  const provider = new ApktoolProvider({
    environment: { REA_APKTOOL_COMMAND: "/nonexistent/apktool" },
  });
  const availability = await provider.inspectAvailability();
  expect(availability).toMatchObject({
    status: "unavailable",
    code: "executable_missing",
  });
  const projected = await refusedBy(provider, {
    operation: "inspect_apktool_client",
    input: {},
  });
  expect(projected).toMatchObject({ code: "capability_unavailable" });
  expect(projected.details).toMatchObject({
    provider_id: "apktool",
    reason: expect.stringContaining("REA_APKTOOL_COMMAND") as unknown,
  });
});

it("rejects a target that is not a readable file", async () => {
  const { command, root } = await writeApktoolStub(decodeStub());
  const projected = await refusedBy(providerOver(command), {
    operation: "decode_android_resources",
    input: { path: join(root, "absent.apk"), include_strings: true },
  });
  expect(projected).toMatchObject({ code: "invalid_request" });
});

it("cancels before spawning anything", async () => {
  const { command, root } = await writeApktoolStub(
    (root) => `: > ${join(root, "spawned")}
if [ "$1" = "--version" ]; then ${VERSION_BLOCK}; exit 0; fi`,
  );
  const controller = new AbortController();
  controller.abort();
  const result = await providerOver(command).execute(
    {
      operation: "decode_android_resources",
      input: { path: "/targets/x.apk", include_strings: true },
    },
    { signal: controller.signal },
  );
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(projectAnalysisError(result.error)).toMatchObject({
    code: "cancelled",
  });
  expect(
    await readFile(join(root, "spawned")).then(
      () => true,
      () => false,
    ),
  ).toBe(false);
});
