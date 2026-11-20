import { createHash } from "node:crypto";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect } from "vitest";

import { parseEvidence } from "../../../src/domain/evidence.js";
import { parseEvidenceBundle } from "../../../src/domain/evidenceBundle.js";
import { connectLocalToolsMcp } from "../../fixtures/localToolsMcp.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import {
  cliTest,
  type SharedMcpCall,
  type TestCli,
} from "../../support/cli/cliFixture.js";

const plist =
  '<plist version="1.0"><dict><key>CFBundleExecutable</key><string>Other</string></dict></plist>';

const expectMachoSummaryProvenance = async (
  cli: TestCli,
  framework: string,
  root: string,
  expected: unknown,
) => {
  const destination = join(root, "inspection.json");
  const result = await cli.run({
    arguments: [
      "inspect-macho",
      framework,
      "--detail",
      "summary",
      "--evidence_output",
      destination,
      "--json",
    ],
  });
  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.json).toMatchObject({
    summary: {
      normalized_result: { summary: { bundle_provenance: expected } },
    },
  });
  const saved = parseEvidenceBundle(
    JSON.parse(await readFile(destination, "utf8")),
  );
  expect(saved.records).toMatchObject([
    {
      operation: "inspect_macho",
      normalized_result: { bundle_provenance: expected },
    },
  ]);
};

const expectRefreshedBundleProvenance = async (
  call: SharedMcpCall,
  framework: string,
  infoPlist: string,
  executableDigest: string,
) => {
  const changedPlist = plist.replace("<dict>", "<dict><!-- updated -->");
  await writeFile(infoPlist, changedPlist);
  const observedBeforeReopen = await call("inspect_signature", {});
  expect(
    observedBeforeReopen.isError,
    JSON.stringify(observedBeforeReopen),
  ).not.toBe(true);
  expect(
    parseEvidence(observedBeforeReopen.structuredContent).normalized_result,
  ).toMatchObject({
    bundle_provenance: {
      info_plist_sha256: createHash("sha256").update(plist).digest("hex"),
    },
  });
  const reopened = await call("open_binary", { path: framework });
  expect(reopened.isError, JSON.stringify(reopened)).not.toBe(true);
  const currentDigest = createHash("sha256").update(changedPlist).digest("hex");
  for (const tool of ["inspect_macho", "inspect_signature"] as const) {
    const inspected = await call(tool, {});
    expect(inspected.isError, JSON.stringify(inspected)).not.toBe(true);
    expect(parseEvidence(inspected.structuredContent)).toMatchObject({
      subject: { identity: { sha256: executableDigest } },
      normalized_result: {
        bundle_provenance: {
          info_plist_sha256: currentDigest,
          declared_executable: "Other",
        },
      },
    });
  }
};

describe.skipIf(process.platform !== "darwin")(
  "selected Apple bundle executable provenance",
  () => {
    cliTest(
      "keeps matching CLI and MCP bundle facts while inspecting the declared file",
      async ({ cli, processes }) => {
        const root = await createTestTempDirectory("rea-bundle-provenance-");
        const framework = join(root, "Demo.framework");
        const version = join(framework, "Versions", "A");
        const executable = join(version, "Other");
        const source = join(root, "probe.c");
        await mkdir(join(version, "Resources"), { recursive: true });
        await symlink("A", join(framework, "Versions", "Current"));
        await writeFile(join(version, "Resources", "Info.plist"), plist);
        await writeFile(source, "int rea_fixture_value(void) { return 7; }\n");
        const compilation = await processes.run("/usr/bin/xcrun", [
          "clang",
          "-dynamiclib",
          source,
          "-o",
          executable,
        ]);
        expect(compilation.exitCode, compilation.stderr).toBe(0);
        const digest = createHash("sha256")
          .update(await readFile(executable))
          .digest("hex");
        const expected = {
          canonical_path: framework,
          layout: "versioned-framework",
          info_plist_path: join(
            framework,
            "Versions",
            "Current",
            "Resources",
            "Info.plist",
          ),
          info_plist_sha256: createHash("sha256").update(plist).digest("hex"),
          declared_executable: "Other",
          version_directory: version,
          framework: {
            directory_name: "Demo",
            matches_declared_executable: false,
          },
        };

        const environment = { HOME: root, REA_LOG_LEVEL: "silent" };
        const inspect = async (command: string, path: string) => {
          const result = await cli.run({
            arguments: [command, path, "--json"],
            environment,
          });
          expect(result.exitCode, result.stdout + result.stderr).toBe(0);
          return parseEvidence(result.json);
        };
        const { call } = await connectLocalToolsMcp(environment);
        const opened = await call("open_binary", { path: framework });
        expect(opened.isError, JSON.stringify(opened)).not.toBe(true);
        for (const [command, tool] of [
          ["inspect-macho", "inspect_macho"],
          ["inspect-signature", "inspect_signature"],
        ] as const) {
          const selected = await inspect(command, framework);
          const direct = await inspect(command, executable);
          expect(selected.subject).toEqual(direct.subject);
          expect(selected.subject).toMatchObject({
            local_path: executable,
            identity: { sha256: digest },
          });
          expect(direct.normalized_result).not.toHaveProperty(
            "bundle_provenance",
          );
          expect(selected.normalized_result).toHaveProperty(
            "bundle_provenance",
            expected,
          );

          const mcp = await call(tool, {});
          expect(mcp.isError, JSON.stringify(mcp)).not.toBe(true);
          const evidence = parseEvidence(mcp.structuredContent);
          expect(evidence.subject).toEqual(selected.subject);
          expect(evidence.normalized_result).toHaveProperty(
            "bundle_provenance",
            expected,
          );
        }
        const summary = await call("inspect_macho", { detail: "summary" });
        expect(summary.isError, JSON.stringify(summary)).not.toBe(true);
        expect(parseEvidence(summary.structuredContent)).toMatchObject({
          normalized_result: { summary: { bundle_provenance: expected } },
        });
        await expectMachoSummaryProvenance(cli, framework, root, expected);
        await expectRefreshedBundleProvenance(
          call,
          framework,
          join(version, "Resources", "Info.plist"),
          digest,
        );
        const reopened = await call("open_binary", { path: executable });
        expect(reopened.isError, JSON.stringify(reopened)).not.toBe(true);
        const direct = await call("inspect_signature", {});
        expect(direct.isError, JSON.stringify(direct)).not.toBe(true);
        expect(
          parseEvidence(direct.structuredContent).normalized_result,
        ).not.toHaveProperty("bundle_provenance");
        expect((await call("close_binary", {})).isError).not.toBe(true);
        expect(
          createHash("sha256")
            .update(await readFile(executable))
            .digest("hex"),
        ).toBe(digest);
      },
    );
  },
);
