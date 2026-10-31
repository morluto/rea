import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { buildBinary } from "plist";
import { describe, expect } from "vitest";
import { z } from "zod";

import { nativeInvestigationTraceSchema } from "../../src/domain/native/nativeInvestigationGraph.js";
import { nativeDispatchMetadataResultSchema } from "../../src/domain/native/objcSwiftMetadata.js";
import { connectLocalToolsMcp } from "../fixtures/localToolsMcp.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { cliTest } from "../support/cli/cliFixture.js";
import type { TestProcesses } from "../support/process/processFixture.js";

const HANDLER = "-[AuditController runAction:]";
const SOURCE = `#import <Cocoa/Cocoa.h>
__attribute__((noinline)) void audit_tail_sink(id value) { __asm__ volatile("" : : "r"(value) : "memory"); }
@interface AuditController : NSViewController
- (IBAction)runAction:(id)sender;
@end
@implementation AuditController
- (IBAction)runAction:(id)sender { audit_tail_sink(sender); }
@end
int main(void) { return 0; }
`;
/** Keep provider selection on REA's own Interface Builder and Mach-O readers. */
const LOCAL_READERS = {
  REA_LOG_LEVEL: "silent",
  REA_ANALYSIS_PROVIDER: "auto",
  HOPPER_LAUNCHER_PATH: "/rea-unconfigured-deep-provider/hopper",
  GHIDRA_INSTALL_DIR: "/rea-unconfigured-deep-provider/ghidra",
  JAVA_HOME: "/rea-unconfigured-deep-provider/java",
  REA_IDA_MCP_CONFIG: "/rea-unconfigured-deep-provider/ida-mcp.json",
  REA_KUNA_COMMAND: "/rea-unconfigured-deep-provider/kuna",
  REA_KUNA_CACHE_DIR: "/rea-unconfigured-deep-provider/kuna-cache",
};
const evidenceOf = <Schema extends z.ZodType>(schema: Schema) =>
  z.object({
    subject: z.object({ architecture: z.string() }),
    normalized_result: schema,
  });
const traceEvidence = evidenceOf(nativeInvestigationTraceSchema);
const metadataEvidence = evidenceOf(nativeDispatchMetadataResultSchema);

/** Bundle a compiled handler with a keyed-archive NIB action wired to it. */
const writeApp = async (root: string, executable: string) => {
  const app = join(root, "Audit.app");
  const contents = join(app, "Contents");
  await mkdir(join(contents, "MacOS"), { recursive: true });
  await mkdir(join(contents, "Resources"));
  await copyFile(executable, join(contents, "MacOS", "Audit"));
  await writeFile(
    join(contents, "Info.plist"),
    "<plist><dict><key>CFBundleExecutable</key><string>Audit</string></dict></plist>",
  );
  await writeFile(
    join(contents, "Resources", "Main.nib"),
    buildBinary({
      $archiver: "NSKeyedArchiver",
      $version: 100000,
      $objects: [
        "$null",
        { $class: { UID: 4 } },
        { $class: { UID: 5 }, NSClassName: "AuditController" },
        {
          $class: { UID: 6 },
          NSSource: { UID: 1 },
          NSDestination: { UID: 2 },
          NSLabel: "runAction:",
        },
        {
          $classname: "NSButton",
          $classes: ["NSButton", "NSControl", "NSView", "NSObject"],
        },
        {
          $classname: "NSCustomObject",
          $classes: ["NSCustomObject", "NSObject"],
        },
        {
          $classname: "NSNibControlConnector",
          $classes: ["NSNibControlConnector", "NSNibConnector", "NSObject"],
        },
      ],
      $top: { root: { UID: 1 } },
    }),
  );
  return { app, executable: join(contents, "MacOS", "Audit") };
};

/** Map the handler symbol through Apple's own symbol, load-command and FAT readers. */
const independentHandlerLocation = async (
  processes: TestProcesses,
  executable: string,
  architecture: string,
) => {
  const tool = async (...arguments_: string[]) => {
    const result = await processes.run("/usr/bin/xcrun", arguments_, {
      timeoutMs: 30_000,
    });
    expect(result.exitCode, result.stderr).toBe(0);
    return result.stdout;
  };
  const symbol = (await tool("nm", "-arch", architecture, executable))
    .split("\n")
    .find((line) => line.endsWith(` ${HANDLER}`));
  expect(symbol, `nm lacks ${HANDLER}`).toBeDefined();
  const address = BigInt(`0x${symbol!.trim().split(/\s+/u)[0]!}`);
  const segment = [
    ...(await tool("otool", "-arch", architecture, "-l", executable)).matchAll(
      /cmd LC_SEGMENT_64\n\s+cmdsize \d+\n\s+segname \S+\n\s+vmaddr (0x[0-9a-f]+)\n\s+vmsize 0x[0-9a-f]+\n\s+fileoff (\d+)\n\s+filesize (\d+)/gu,
    ),
  ]
    .map(([, vmaddr, fileoff, filesize]) => ({
      address: BigInt(vmaddr!),
      offset: BigInt(fileoff!),
      size: BigInt(filesize!),
    }))
    .find(
      (candidate) =>
        candidate.address <= address &&
        address < candidate.address + candidate.size,
    );
  expect(segment, `no file-backed segment maps ${HANDLER}`).toBeDefined();
  const fat = await tool("otool", "-f", "-v", executable);
  const slice = !fat.startsWith("Fat headers")
    ? "0"
    : /^\s+offset (\d+)$/mu.exec(
        fat
          .split(/^architecture /mu)
          .find((block) => block.startsWith(`${architecture}\n`)) ?? "",
      )?.[1];
  expect(slice, `otool lacks the ${architecture} slice`).toBeDefined();
  return {
    address: `0x${address.toString(16)}`,
    file_offset: Number(
      BigInt(slice!) + segment!.offset + address - segment!.address,
    ),
  };
};

describe.skipIf(process.platform !== "darwin")(
  "compiled Objective-C UI handler locations",
  () => {
    cliTest(
      "locates the handler's code, not its method record, in thin and universal images",
      async ({ cli, processes }) => {
        const root = await createTestTempDirectory("rea-ui-handler-location-");
        const source = join(root, "handler.m");
        await writeFile(source, SOURCE);
        const { call } = await connectLocalToolsMcp(LOCAL_READERS);
        const good = async (name: string, arguments_: object) => {
          const result = await call(name, { ...arguments_ });
          expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
          return result.structuredContent;
        };
        for (const variant of [
          // arm64 always uses relative method lists.
          { name: "arm64", flags: ["-arch", "arm64"], encoding: "relative" },
          // A pre-macOS 11 x86_64 image keeps absolute method lists.
          {
            name: "x86_64",
            flags: ["-arch", "x86_64", "-mmacosx-version-min=10.15"],
            encoding: "absolute",
          },
          // The selected slice's offsets are relative to the container.
          {
            name: "universal",
            flags: [
              "-arch",
              "x86_64",
              "-arch",
              "arm64",
              "-mmacosx-version-min=10.15",
            ],
            encoding: undefined,
          },
        ]) {
          const directory = join(root, variant.name);
          await mkdir(directory);
          const compiled = await processes.run(
            "/usr/bin/xcrun",
            [
              "clang",
              ...variant.flags,
              "-O2",
              "-framework",
              "Cocoa",
              source,
              "-o",
              join(directory, "Audit"),
            ],
            { timeoutMs: 60_000 },
          );
          expect(compiled.exitCode, compiled.stderr).toBe(0);
          const { app, executable } = await writeApp(
            directory,
            join(directory, "Audit"),
          );
          const before = await readFile(executable);

          await good("open_binary", { path: app });
          const traced = traceEvidence.parse(
            await good("trace_native_ui_action", { action: "runAction:" }),
          );
          const metadata = metadataEvidence.parse(
            await good("inspect_native_dispatch_metadata", {}),
          );
          await good("close_binary", {});

          const expected = await independentHandlerLocation(
            processes,
            executable,
            traced.subject.architecture,
          );
          const functionId = `native:function:${expected.address}`;
          const trace = traced.normalized_result;
          expect(trace.edges, variant.name).toContainEqual(
            expect.objectContaining({
              relation: "objc_dispatch",
              resolution: "resolved",
              to: functionId,
            }),
          );
          const handler = trace.nodes.find(({ id }) => id === functionId);
          expect(handler?.location, variant.name).toEqual(expected);

          const record =
            metadata.normalized_result.result.objc_dispatch_implementations.find(
              ({ class_name, selector }) =>
                class_name === "AuditController" && selector === "runAction:",
            );
          expect(record, variant.name).toMatchObject({
            implementation_address: expected.address,
            implementation_file_offset: expected.file_offset,
          });
          // The fixture is discriminating only while the record lies elsewhere.
          expect(record?.location.file_offset).not.toBe(expected.file_offset);
          expect(handler?.evidence, variant.name).toEqual([
            expect.objectContaining({
              kind: "binary_metadata",
              description:
                variant.encoding === undefined
                  ? expect.any(String)
                  : `Encoded ${variant.encoding} Objective-C method entry`,
              location: record?.location,
            }),
          ]);

          if (variant.name === "universal") {
            const output = await cli.run({
              arguments: [
                "trace-native-ui-action",
                app,
                "runAction:",
                "--json",
              ],
              environment: LOCAL_READERS,
            });
            expect(output.exitCode, output.stderr).toBe(0);
            const cliTrace = traceEvidence.parse(output.json).normalized_result;
            expect(cliTrace.nodes.find(({ id }) => id === functionId)).toEqual(
              handler,
            );
          }
          expect(Buffer.compare(await readFile(executable), before)).toBe(0);
        }
      },
      120_000,
    );
  },
);
