import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { bindExecutionTarget } from "../../../../src/application/binary/BinarySessionExecution.js";
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

it("records each plist byte digest under the open executable including an explicitly selected file outside the bundle", async () => {
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
  const runner = new NativeFixtureRunner();
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

  for (const path of [outside, "../Outside.plist"]) {
    const selected = await client.execute("inspect_plist", { path });
    if (!selected.ok) throw selected.error;
    expect(inspectPlistSchema.parse(selected.value.result)).toMatchObject({
      source_path: path === outside ? outside : `${app}/../Outside.plist`,
      source_sha256: createHash("sha256")
        .update(plist("outside"))
        .digest("hex"),
      value: { Marker: "outside" },
    });
  }

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

it.each([
  ["xml", plist("first"), "XML 1.0 document text", ["file", "plutil"]],
  ["openstep", "{ Marker = first; }", "ASCII text", ["file", "plutil"]],
] as const)(
  "binds %s observation and digest to the original stable bytes after the source changes",
  async (format, source, description, commands) => {
    const root = await createTestTempDirectory("rea-plist-evidence-stable-");
    const path = join(root, "selected.plist");
    await writeFile(path, source);
    const observed: string[] = [];
    let operand: string | undefined;
    const replay = new NativeFixtureRunner({ file: description });
    const provider = new NativeMacOSProvider(
      {},
      {
        async run(tool, arguments_) {
          const selected = arguments_.at(-1);
          if (selected === undefined)
            throw new Error("Expected a plist operand");
          observed.push(tool);
          const capture = await replay.run(tool, arguments_);
          if (tool === "file") {
            operand = selected;
            await writeFile(
              path,
              format === "xml" ? plist("second") : "{ Marker = second; }",
            );
            return capture;
          }
          expect(selected).toBe(operand);
          const conversionInput = await readFile(selected, "utf8");
          if (arguments_[0] === "-lint") {
            expect(conversionInput).toBe(source);
            return capture;
          }
          const stdout = JSON.stringify({
            Marker: conversionInput.includes("first") ? "first" : "second",
          });
          if (!capture.ok) return capture;
          return ok({
            ...capture.value,
            stdout,
            stdoutBytes: Buffer.byteLength(stdout),
          });
        },
      },
      "darwin",
    );
    const target = await nativeMachoTargetForFile(path);
    const client = provider.createClient(target);
    onTestFinished(async () => {
      const closed = await client.close();
      if (!closed.ok) throw closed.error;
    });
    const result = await client.execute("inspect_plist", { path });
    if (!result.ok) throw result.error;
    expect(observed).toEqual(commands);
    expect(await readFile(path, "utf8")).toContain("second");
    expect(inspectPlistSchema.parse(result.value.result)).toMatchObject({
      source_path: path,
      source_sha256: createHash("sha256").update(source).digest("hex"),
      value: { Marker: "first" },
    });
    expect(operand).toBeDefined();
    expect(operand).not.toBe(path);
    await expect(access(operand!)).rejects.toMatchObject({ code: "ENOENT" });
  },
);
