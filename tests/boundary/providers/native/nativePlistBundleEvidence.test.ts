import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { bindExecutionTarget } from "../../../../src/application/binary/BinarySessionExecution.js";
import { projectAnalysisError } from "../../../../src/domain/analysisErrorProjection.js";
import { inspectPlistSchema } from "../../../../src/domain/native/nativeInspection.js";
import { ok } from "../../../../src/domain/result.js";
import { NativeMacOSProvider } from "../../../../src/native/NativeMacOSProvider.js";
import {
  NativeFixtureRunner,
  nativeMachoTargetForFile,
} from "../../../fixtures/nativeCommands.js";
import { createTestTempDirectory } from "../../../fixtures/temporaryDirectory.js";

const plist = (marker: string): string =>
  `<plist><dict><key>CFBundleExecutable</key><string>Probe</string><key>Marker</key><string>${marker}</string></dict></plist>`;

it("records each plist byte digest under the open executable and refuses a file outside the bundle", async () => {
  const root = await createTestTempDirectory("rea-plist-bundle-evidence-");
  const app = join(root, "Probe.app");
  const contents = join(app, "Contents");
  const executable = join(contents, "MacOS", "Probe");
  await mkdir(join(contents, "MacOS"), { recursive: true });
  await mkdir(join(contents, "Frameworks/Helper.framework/Resources"), {
    recursive: true,
  });
  await writeFile(executable, "probe-executable");
  const info = join(contents, "Info.plist");
  const infoBytes = plist("bundle");
  const nested = join(
    contents,
    "Frameworks/Helper.framework/Resources/Info.plist",
  );
  const nestedBytes = plist("helper");
  await writeFile(info, infoBytes);
  await writeFile(nested, nestedBytes);
  const outside = join(root, "Outside.plist");
  await writeFile(outside, plist("outside"));
  const target = {
    ...(await nativeMachoTargetForFile(executable, app)),
    bundleInfoPlist: info,
  };
  const calls: string[] = [];
  const runner = new NativeFixtureRunner();
  const original = runner.run.bind(runner);
  runner.run = async (tool, args, options) => {
    calls.push(args.at(-1) ?? tool);
    if (args.some((argument) => argument.includes("Outside.plist")))
      throw new Error(`read ${tool} for a plist outside the bundle`);
    return original(tool, args, options);
  };
  const client = new NativeMacOSProvider({}, runner, "darwin").createClient(
    target,
  );
  onTestFinished(async () => {
    await client.close();
  });

  const inspected = await client.execute("inspect_plist", {});
  if (!inspected.ok) throw inspected.error;
  const infoDigest = createHash("sha256").update(infoBytes).digest("hex");
  expect(inspectPlistSchema.parse(inspected.value.result)).toMatchObject({
    source_path: info,
    source_sha256: infoDigest,
    value: { Marker: "bundle" },
  });
  const bound = bindExecutionTarget(
    ok(inspected.value),
    "inspect_plist",
    target,
  );
  if (!bound.ok) throw bound.error;
  expect(bound.value.subject).toMatchObject({
    sha256: target.sha256,
    format: "mach-o",
    path: executable,
  });

  calls.length = 0;
  const helper = await client.execute("inspect_plist", { path: nested });
  if (!helper.ok) throw helper.error;
  const helperDigest = createHash("sha256")
    .update(await readFile(nested))
    .digest("hex");
  expect(helperDigest).not.toBe(infoDigest);
  expect(inspectPlistSchema.parse(helper.value.result).source_sha256).toBe(
    helperDigest,
  );
  const helperBound = bindExecutionTarget(
    ok(helper.value),
    "inspect_plist",
    target,
  );
  if (!helperBound.ok) throw helperBound.error;
  expect(helperBound.value.subject?.sha256).toBe(target.sha256);

  calls.length = 0;
  const refused = await client.execute("inspect_plist", { path: outside });
  if (refused.ok) throw new Error("inspected a plist outside the bundle");
  expect(projectAnalysisError(refused.error)).toMatchObject({
    code: "invalid_request",
    details: { issues: [{ path: ["path"], reason: "invalid_value" }] },
  });
  expect(calls).toEqual([]);

  expect(
    inspectPlistSchema.parse({
      format: "xml",
      value: {},
      bundle: {
        identifier: null,
        executable: null,
        name: null,
        version: null,
        short_version: null,
      },
      source_path: info,
      provenance: [],
      limitations: [],
    }).source_sha256,
  ).toBeUndefined();
});
