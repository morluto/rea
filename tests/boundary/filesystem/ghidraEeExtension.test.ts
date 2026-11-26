import {
  lstat,
  mkdir,
  readFile,
  readdir,
  utimes,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { parseConfig } from "../../../src/config/parseConfig.js";
import type { BinaryTarget } from "../../../src/domain/binaryTargetTypes.js";
import { ok as javaProbeOk } from "../../../src/domain/result.js";
import { inspectGhidraEeExtension } from "../../../src/ghidra/GhidraEeExtension.js";
import type { GhidraInstallationHost } from "../../../src/ghidra/GhidraInstallation.js";
import type { GhidraJavaObservation } from "../../../src/ghidra/GhidraJavaProbe.js";
import { GhidraHeadlessLauncher } from "../../../src/ghidra/GhidraLauncher.js";
import { GhidraProvider } from "../../../src/ghidra/GhidraProvider.js";
import type { GhidraProviderClientFactory } from "../../../src/ghidra/GhidraProviderClient.js";
import { GHIDRA_SESSION_CAPABILITIES } from "../../../src/ghidra/GhidraSessionValues.js";
import {
  SUPPORTED_GHIDRA_JAVA_MAJOR,
  SUPPORTED_GHIDRA_VERSION,
} from "../../../src/ghidra/GhidraReleasePolicy.js";
import { silentLogger } from "../../../src/logger.js";
import { ArtifactResourceScope } from "../../../src/resources/ArtifactResourceScope.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const INSTALL_VERSION = SUPPORTED_GHIDRA_VERSION;
const LANGUAGES = "data/languages";
const SLA = `${LANGUAGES}/r5900.sla`;
const SLASPEC = `${LANGUAGES}/r5900.slaspec`;
// Synthetic installation files exercise the filesystem/profile boundary only;
// the compiled-language rule mirrors Ghidra 12.2 SleighLanguageFile.
const COMPILED = Buffer.concat([
  Buffer.from([0x73, 0x6c, 0x61, 0x04]),
  Buffer.from("synthetic packed language"),
]);
const SOURCE_TIME = new Date("2026-01-01T00:00:00Z");
const COMPILED_TIME = new Date("2026-01-02T00:00:00Z");
const LATER_TIME = new Date("2026-01-03T00:00:00Z");

const target = {
  kind: "executable",
  format: "elf",
  architecture: "mips",
  availableArchitectures: ["mips"],
  path: "/caller/ps2.elf",
  sha256: "a".repeat(64),
  mips: {
    elfClass: 32,
    byteOrder: "little",
    type: 2,
    flags: 0x20924000,
    gnuAttributes: null,
    abiFlags: null,
  },
} satisfies BinaryTarget;
const host: GhidraInstallationHost = {
  platform: "linux",
  architecture: "x64",
  readText: () =>
    `application.version=${INSTALL_VERSION}\napplication.java.min=${String(SUPPORTED_GHIDRA_JAVA_MAJOR)}\n`,
  executable: () => true,
  probeJava: () =>
    javaProbeOk<GhidraJavaObservation>({
      osArch: "amd64",
      osName: "Linux",
      version: `${String(SUPPORTED_GHIDRA_JAVA_MAJOR)}.0.1`,
      major: SUPPORTED_GHIDRA_JAVA_MAJOR,
      home: "/jdk-25",
      bits: 64,
      runtime: "jdk",
    }),
};

async function installation(
  overrides: Readonly<Record<string, string | Buffer | null>> = {},
) {
  const directory = await createTestTempDirectory("rea-ee-profile-");
  const root = join(
    directory,
    "Ghidra",
    "Extensions",
    "ghidra-emotionengine-reloaded",
  );
  const contents: Record<string, string | Buffer | null> = {
    "Module.manifest": "",
    "extension.properties": `name=ghidra-emotionengine-reloaded\nversion=${INSTALL_VERSION}\n`,
    [`${LANGUAGES}/emotionengine.ldefs`]: "synthetic language definition",
    [SLASPEC]:
      '# synthetic\n@include "base.sinc"\n  @include "ignored.sinc"\n@include "cop2.sinc" # trailing\n',
    [`${LANGUAGES}/base.sinc`]: "define endian=little;\n",
    [`${LANGUAGES}/cop2.sinc`]: '@include "vu/upper.sinc"\n',
    [`${LANGUAGES}/vu/upper.sinc`]: "# leaf\n",
    [`${LANGUAGES}/r5900.pspec`]: "synthetic processor specification",
    [`${LANGUAGES}/r5900.cspec`]: "synthetic compiler specification",
    [SLA]: COMPILED,
    "lib/extension.jar": "synthetic loader artifact",
    ...overrides,
  };
  for (const [path, content] of Object.entries(contents)) {
    if (content === null) continue;
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
    await utimes(
      join(root, path),
      path === SLA ? COMPILED_TIME : SOURCE_TIME,
      path === SLA ? COMPILED_TIME : SOURCE_TIME,
    );
  }
  await mkdir(join(directory, "support"));
  const parsed = parseConfig({ GHIDRA_INSTALL_DIR: directory });
  if (!parsed.ok) throw parsed.error;
  const launches: Parameters<GhidraProviderClientFactory>[0][] = [];
  return {
    directory,
    root,
    launches,
    provider: new GhidraProvider(parsed.value, silentLogger, {}, host),
    // The client seam stands in for the JVM after every open-time check ran.
    opening: new GhidraProvider(
      parsed.value,
      silentLogger,
      {},
      host,
      (options) => {
        launches.push(options);
        return {
          start: () => Promise.resolve(javaProbeOk(eeSession)),
          callTool: () => Promise.resolve(javaProbeOk(null)),
          close: () => Promise.resolve(javaProbeOk(null)),
        };
      },
    ),
  };
}

const eeSession = {
  name: "REA Ghidra bridge" as const,
  run_id: "11111111-1111-4111-8111-111111111111",
  profile_digest: "a".repeat(64),
  provider: { id: "ghidra" as const, version: INSTALL_VERSION },
  read_only: false,
  analysis_complete: true,
  analysis_timed_out: false,
  capabilities: [...GHIDRA_SESSION_CAPABILITIES],
  target: {
    name: "ps2.elf",
    language_id: "r5900:LE:32:default",
    compiler_spec_id: "default",
    image_base: "0x0",
    default_address_space: "ram",
    sha256: "a".repeat(64),
  },
};

/** Every installed path with its bytes and modification time. */
async function snapshot(root: string): Promise<Record<string, string>> {
  const state: Record<string, string> = {};
  const walk = async (relative: string): Promise<void> => {
    const path = join(root, relative);
    const metadata = await lstat(path);
    if (metadata.isDirectory()) {
      for (const child of (await readdir(path)).sort())
        await walk(relative === "" ? child : `${relative}/${child}`);
      return;
    }
    state[relative] =
      `${String(metadata.mtimeMs)}:${(await readFile(path)).toString("base64")}`;
  };
  await walk("");
  return state;
}

const inspect = (root: string) =>
  inspectGhidraEeExtension(root, INSTALL_VERSION, new ArtifactResourceScope());

describe.skipIf(process.platform === "win32")(
  "EE compiled-language admission",
  () => {
    it("admits a fresh format-4 language and binds its content into the profile", async () => {
      const { provider, root } = await installation();
      const resolved = await provider.resolveAnalysisProfile(target);
      if (!resolved.ok) throw resolved.error;
      expect(resolved.value.profile?.parameters).toMatchObject({
        language_id: "r5900:LE:32:default",
        ee_extension: {
          id: "ghidra-emotionengine-reloaded",
          root,
          ghidra_version: INSTALL_VERSION,
          sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        },
      });
    });

    it("opens a resolved EE profile with the pinned language and extension", async () => {
      const { opening, launches, root } = await installation();
      onTestFinished(async () => {
        await opening.closeOwnedResources();
      });
      const resolved = await opening.resolveAnalysisProfile(target);
      if (!resolved.ok || resolved.value.profile === null)
        throw new Error("expected an EE profile");
      const client = opening.createClient(target, resolved.value.profile);
      onTestFinished(async () => {
        await client.close();
      });
      const health = await client.execute("health", {});
      if (!health.ok) throw health.error;
      expect(launches).toHaveLength(1);
      expect(launches[0]).toMatchObject({
        expectedLanguageId: "r5900:LE:32:default",
        expectedCompilerSpecId: "default",
        launcher: {
          options: {
            languageOverride: {
              languageId: "r5900:LE:32:default",
              compilerSpecId: "default",
            },
            eeExtension: { id: "ghidra-emotionengine-reloaded", root },
          },
        },
      });
    });

    it("treats a source as old as its compiled language as fresh", async () => {
      const { root } = await installation();
      await utimes(join(root, SLASPEC), COMPILED_TIME, COMPILED_TIME);
      await expect(inspect(root)).resolves.toMatchObject({
        id: "ghidra-emotionengine-reloaded",
      });
    });

    it.each([
      [
        "missing",
        { [SLA]: null },
        { code: "compiled_language_missing", component: SLA },
      ],
      [
        "an older SLA format",
        {
          [SLA]: Buffer.concat([
            Buffer.from([0x73, 0x6c, 0x61, 0x03]),
            Buffer.from("old"),
          ]),
        },
        {
          code: "compiled_language_format",
          required_format: 4,
          observed_format: 3,
        },
      ],
      [
        "not SLA at all",
        { [SLA]: "<sleigh version='3'/>" },
        { code: "compiled_language_format", required_format: 4 },
      ],
      [
        "an include outside the extension",
        { [`${LANGUAGES}/base.sinc`]: '@include "../../../../MIPS/x.sinc"\n' },
        {
          code: "compiled_language_source_unresolved",
          include: "../../../../MIPS/x.sinc",
          reason: "outside_inventory",
        },
      ],
      [
        "an absolute include",
        { [`${LANGUAGES}/base.sinc`]: '@include "/opt/x.sinc"\n' },
        {
          code: "compiled_language_source_unresolved",
          reason: "outside_inventory",
        },
      ],
      [
        "a variable include",
        { [`${LANGUAGES}/base.sinc`]: '@include "$(DIR)/x.sinc"\n' },
        {
          code: "compiled_language_source_unresolved",
          reason: "outside_inventory",
        },
      ],
      [
        "a missing include, even in a conditional branch",
        {
          [`${LANGUAGES}/base.sinc`]:
            '@ifdef NEVER\n@include "absent.sinc"\n@endif\n',
        },
        {
          code: "compiled_language_source_unresolved",
          source: `${LANGUAGES}/absent.sinc`,
          reason: "not_installed",
        },
      ],
      [
        "an include cycle",
        { [`${LANGUAGES}/vu/upper.sinc`]: '@include "../cop2.sinc"\n' },
        {
          code: "compiled_language_source_unresolved",
          source: `${LANGUAGES}/cop2.sinc`,
          reason: "include_cycle",
        },
      ],
    ] as const)(
      "refuses a compiled language that is %s",
      async (_name, overrides, diagnostics) => {
        const { provider, root } = await installation(overrides);
        const before = await snapshot(root);
        const refused = await provider.resolveAnalysisProfile(target);
        if (refused.ok) throw new Error("Refused language was admitted");
        expect(refused.error).toMatchObject({ diagnostics });
        expect(refused.error.message).toContain("EE_EXTENSION_UNAVAILABLE");
        expect(refused.error.message).toContain(
          "Precompile data/languages/r5900.sla",
        );
        expect(await snapshot(root)).toEqual(before);
      },
    );

    it.each([
      [SLASPEC, SLASPEC],
      [`${LANGUAGES}/vu/upper.sinc`, `${LANGUAGES}/vu/upper.sinc`],
    ])("refuses a compiled language older than %s", async (changed, source) => {
      const { root } = await installation();
      await utimes(join(root, changed), LATER_TIME, LATER_TIME);
      await expect(inspect(root)).rejects.toMatchObject({
        diagnostics: {
          code: "compiled_language_stale",
          component: SLA,
          source,
        },
      });
    });

    it("does not let an unincluded source make the language stale", async () => {
      const { root } = await installation({
        [`${LANGUAGES}/unused.sinc`]: "# not included\n",
      });
      await utimes(
        join(root, `${LANGUAGES}/unused.sinc`),
        LATER_TIME,
        LATER_TIME,
      );
      await expect(inspect(root)).resolves.toMatchObject({
        id: "ghidra-emotionengine-reloaded",
      });
    });

    it("refuses a language that became stale after resolution before starting a provider", async () => {
      const { directory, root } = await installation();
      const extension = await inspect(root);
      await utimes(
        join(root, `${LANGUAGES}/cop2.sinc`),
        LATER_TIME,
        LATER_TIME,
      );
      const before = await snapshot(root);
      const spawn = vi.fn();
      const launcher = new GhidraHeadlessLauncher({
        environment: {},
        analyzeHeadlessPath: join(directory, "support/analyzeHeadless"),
        configurationDirectoryName: `ghidra_${INSTALL_VERSION}_PUBLIC`,
        javaHome: "/jdk-25",
        bridgeScriptPath: "/packaged/ReaGhidraBridge.java",
        eeExtension: extension,
        spawnProcess: spawn,
      });
      const launched = await launcher.launch(
        {
          runtimeRoot: join(directory, "runtime"),
          transport: "unix-socket",
          endpointPath: join(directory, "socket"),
          token: "test-only-token",
          runId: "00000000-0000-4000-8000-000000000001",
          targetPath: target.path,
          targetSha256: target.sha256,
          providerVersion: INSTALL_VERSION,
          profileDigest: "b".repeat(64),
        },
        { resourceScope: new ArtifactResourceScope() },
      );
      expect(launched.ok).toBe(false);
      if (launched.ok)
        throw new Error("Stale language reached provider startup");
      expect(String(launched.error.cause)).toContain("compiled_language_stale");
      expect(spawn).not.toHaveBeenCalled();
      expect(await snapshot(root)).toEqual(before);
    });
  },
);
