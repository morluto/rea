import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";

import { createDesktopApplicationService } from "../../../src/composition/desktop.js";
import { desktopApplicationSchema } from "../../../src/domain/desktopApplication.js";
import { buildManagedPeFixture } from "../../../src/dotnet/ManagedPe.fixture.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const inspect = async (path: string) => {
  const service = createDesktopApplicationService();
  try {
    const result = await service.inspect({ path });
    if (!result.ok) throw result.error;
    return desktopApplicationSchema.parse(result.value.normalized_result);
  } finally {
    await service.close();
  }
};
const put = async (root: string, path: string, bytes: Buffer | string) => {
  const destination = join(root, path);
  await mkdir(join(destination, ".."), { recursive: true });
  await writeFile(destination, bytes);
};

/** A complete PE image whose CLI directory is cleared: a native Windows image. */
const nativePe = (): Buffer => {
  const bytes = buildManagedPeFixture({ references: [] });
  const pe = bytes.readUInt32LE(0x3c);
  const optional = pe + 24;
  const directories =
    optional + (bytes.readUInt16LE(optional) === 0x20b ? 112 : 96);
  bytes.fill(0, directories + 14 * 8, directories + 15 * 8);
  return bytes;
};

const pathsOf = (
  report: ReturnType<typeof desktopApplicationSchema.parse>,
  fileIds: readonly string[],
) => {
  const paths = new Map(report.files.map((file) => [file.file_id, file.path]));
  return fileIds.map((id) => paths.get(id));
};

it("recognises a native Qt release and points at its main executable", async () => {
  const root = await createTestTempDirectory("rea-desktop-native-qt-");
  await put(root, "x64dbg.exe", nativePe());
  await put(root, "Qt5Core.dll", nativePe());
  await put(root, "Qt5Widgets.dll", nativePe());
  await put(root, "platforms/qwindows.dll", nativePe());
  await put(root, "vcruntime140.dll", nativePe());
  await put(root, "plugins/helper.exe", nativePe());
  await put(root, "README.txt", "notes");
  const report = await inspect(root);
  expect(report.candidates).toHaveLength(1);
  expect(report.candidates[0]).toMatchObject({
    family: "native",
    confidence: "inferred",
  });
  // The shallowest executable is the main one; nested tools are not.
  expect(pathsOf(report, report.candidates[0]!.basis_file_ids)).toEqual([
    "x64dbg.exe",
  ]);
  expect(
    report.components.map(({ name, category }) => [name, category]),
  ).toEqual([
    ["Qt", "ui-framework"],
    ["Microsoft Visual C++ runtime", "runtime-library"],
  ]);
  const qt = report.components.find(({ name }) => name === "Qt")!;
  expect(pathsOf(report, qt.basis_file_ids).sort()).toEqual([
    "Qt5Core.dll",
    "platforms/qwindows.dll",
  ]);
  expect(
    report.next_probes.map((probe) => [
      probe.operation,
      pathsOf(report, [probe.file_id])[0],
      probe.priority,
    ]),
  ).toEqual([
    ["inspect_pe_imports", "x64dbg.exe", "application"],
    ["inspect_pe_resources", "x64dbg.exe", "application"],
  ]);
});

it("ranks a self-contained .NET release's own assemblies above counted runtime facades", async () => {
  const root = await createTestTempDirectory("rea-desktop-dotnet-rank-");
  const assembly = buildManagedPeFixture({ references: ["System.Runtime"] });
  for (const name of [
    "BeaconLib.dll",
    "Microsoft.Win32.Primitives.dll",
    "OpenRA.Game.dll",
    "RedAlert.dll",
    "System.Private.Xml.Linq.dll",
    "System.Xml.dll",
    "mscorlib.dll",
  ])
    await put(root, name, assembly);
  await put(root, "OpenRA.Game.pdb", "pdb");
  await put(root, "RedAlert.runtimeconfig.json", "{}");
  await put(root, "RedAlert.deps.json", "{}");
  const report = await inspect(root);
  expect(report.candidates.map(({ family }) => family)).toEqual(["dotnet"]);
  const rows = report.next_probes.map((probe) => [
    pathsOf(report, [probe.file_id])[0],
    probe.priority,
  ]);
  expect(rows).toEqual([
    ["OpenRA.Game.dll", "application"],
    ["RedAlert.dll", "application"],
    ["BeaconLib.dll", "dependency"],
  ]);
  expect(report.deferred_probes).toEqual([
    expect.objectContaining({
      operation: "inspect_managed_artifact",
      reason: "runtime-facade",
      count: 4,
    }),
  ]);
});

it("gives each Godot pack carrier a selection probe for its inventory", async () => {
  const root = await createTestTempDirectory("rea-desktop-godot-probe-");
  const pck = Buffer.alloc(20);
  pck.write("GDPC");
  pck.writeUInt32LE(2, 4);
  pck.writeUInt32LE(4, 8);
  await put(root, "Pixelorama.exe", nativePe());
  await put(root, "Pixelorama.pck", pck);
  const report = await inspect(root);
  expect(report.candidates.map(({ family }) => family)).toEqual(["godot"]);
  expect(
    report.next_probes.map((probe) => [
      probe.operation,
      pathsOf(report, [probe.file_id])[0],
    ]),
  ).toEqual([["open_binary", "Pixelorama.pck"]]);
  expect(report.next_probes[0]!.rationale).toContain("inspect_artifact");
});

it.each([
  "wxmsw32u_core_vc14x_x64.dll",
  "libwx_gtk3u_core-3.2.so.0",
  "libwx_baseu-3.2.so.0",
  "libwx_osx_cocoau_core-3.2.dylib",
])("marks %s as wxWidgets", async (name) => {
  const root = await createTestTempDirectory("rea-desktop-wx-");
  await put(root, name, "library");
  const report = await inspect(root);
  expect(report.components.map(({ name: marker }) => marker)).toEqual([
    "wxWidgets",
  ]);
});

it("reads Unix mains without relying on host executable marking", async () => {
  const root = await createTestTempDirectory("rea-desktop-unix-main-");
  const elf = Buffer.alloc(64);
  elf.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]);
  const macho = Buffer.alloc(64);
  macho.writeUInt32LE(0xfeedfacf);
  // Written without the executable bit, as on a Windows host.
  await put(root, "game", elf);
  await put(root, "Game.app/Contents/MacOS/Game", macho);
  const report = await inspect(root);
  expect(report.candidates.map(({ family }) => family)).toEqual(["native"]);
  expect(pathsOf(report, report.candidates[0]!.basis_file_ids)).toEqual([
    "game",
  ]);
  const examined = report.files
    .filter((file) => file.read_status === "examined")
    .map((file) => file.path)
    .sort();
  expect(examined).toEqual(["Game.app/Contents/MacOS/Game", "game"]);
  expect(report.next_probes.map(({ operation }) => operation)).toEqual([
    "inspect_binary_hardening",
    "open_binary",
  ]);
});
