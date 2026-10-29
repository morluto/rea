import { build } from "plist";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";

import { toolContract } from "../../../src/contracts/toolContracts.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { connectLocalToolsMcp } from "../../fixtures/localToolsMcp.js";
import { cliTest } from "../../support/cli/cliFixture.js";

const resourceOperations = [
  "inspect_plist",
  "decode_interface_builder",
  "inspect_asset_catalog",
  "inspect_keyed_archive",
] as const;

cliTest.skipIf(process.platform !== "darwin")(
  "inspects a keyless app resource root through the compiled CLI",
  async ({ cli }) => {
    const temporaryRoot = await createTestTempDirectory(
      "rea-bundle-resource-acceptance-",
    );
    const firstBundle = await createKeylessBundle(temporaryRoot, "First");

    for (const scenario of cliScenarios(firstBundle)) {
      const response = await cli.run({
        arguments: [...scenario.arguments, "--json"],
        environment: { REA_LOG_LEVEL: "silent" },
      });
      expect(
        response.exitCode,
        `${scenario.operation}: ${response.stdout} ${response.stderr}`,
      ).toBe(0);
      const evidence = expectResourceEvidence(
        response.json,
        scenario.operation,
        firstBundle,
      );
      if (scenario.operation === "inspect_keyed_archive")
        expect(evidence.normalized_result).toMatchObject({
          archive_path: "Resources/Archive.plist",
          objects: expect.arrayContaining([
            expect.objectContaining({ value: "resource-only-value" }),
          ]),
        });
    }
  },
);

cliTest.skipIf(process.platform !== "darwin")(
  "retains and switches keyless resource sessions through stdio MCP",
  async () => {
    const temporaryRoot = await createTestTempDirectory(
      "rea-resource-session-acceptance-",
    );
    const firstBundle = await createKeylessBundle(temporaryRoot, "First");
    const secondBundle = await createKeylessBundle(temporaryRoot, "Second");
    const { call } = await connectLocalToolsMcp();
    const opened = await call("open_bundle_resources", { path: firstBundle });
    expect(opened.isError).not.toBe(true);
    expect(
      toolContract("open_bundle_resources").outputSchema.parse(
        opened.structuredContent,
      ),
    ).toMatchObject({
      result: {
        caller_path: firstBundle,
        canonical_path: firstBundle,
        executable_sha256: null,
      },
    });

    const firstStatus = await call("binary_session", {});
    expect(firstStatus.isError).not.toBe(true);
    expect(
      toolContract("binary_session").outputSchema.parse(
        firstStatus.structuredContent,
      ),
    ).toMatchObject({
      result: {
        open: true,
        session_kind: "bundle_resources",
        analysis_provider_binding: null,
        analysis_provider_candidates: [],
        resource_root: {
          canonical_path: firstBundle,
          executable_sha256: null,
        },
      },
    });

    for (const operation of resourceOperations) {
      const arguments_ =
        operation === "inspect_keyed_archive"
          ? { path: "Resources/Archive.plist" }
          : {};
      const response = await call(operation, arguments_);
      expect(response.isError, operation).not.toBe(true);
      const evidence = expectResourceEvidence(
        response.structuredContent,
        operation,
        firstBundle,
      );
      if (operation === "inspect_keyed_archive")
        expect(evidence.normalized_result).toMatchObject({
          archive_path: "Resources/Archive.plist",
          objects: expect.arrayContaining([
            expect.objectContaining({ value: "resource-only-value" }),
          ]),
        });
    }

    const retained = await call("get_evidence_bundle", {});
    expect(retained.isError).not.toBe(true);
    const evidenceBundle = toolContract(
      "get_evidence_bundle",
    ).outputSchema.parse(retained.structuredContent);
    for (const operation of resourceOperations) {
      const record = evidenceBundle.result.records.find(
        (record) => record.operation === operation,
      );
      expectResourceEvidence(record, operation, firstBundle);
    }

    const switched = await call("open_bundle_resources", {
      path: secondBundle,
    });
    expect(switched.isError).not.toBe(true);
    expect(
      toolContract("open_bundle_resources").outputSchema.parse(
        switched.structuredContent,
      ),
    ).toMatchObject({ result: { canonical_path: secondBundle } });
    const switchedStatus = await call("binary_session", {});
    expect(switchedStatus.isError).not.toBe(true);
    expect(
      toolContract("binary_session").outputSchema.parse(
        switchedStatus.structuredContent,
      ),
    ).toMatchObject({
      result: {
        open: true,
        session_kind: "bundle_resources",
        resource_root: {
          caller_path: secondBundle,
          canonical_path: secondBundle,
          executable_sha256: null,
        },
      },
    });

    const closed = await call("close_binary", {});
    expect(closed.isError).not.toBe(true);
    toolContract("close_binary").outputSchema.parse(closed.structuredContent);
    const finalStatus = await call("binary_session", {});
    expect(finalStatus.isError).not.toBe(true);
    expect(
      toolContract("binary_session").outputSchema.parse(
        finalStatus.structuredContent,
      ),
    ).toMatchObject({ result: { open: false, cleanup_pending: false } });
  },
);

const createKeylessBundle = async (
  root: string,
  name: string,
): Promise<string> => {
  const bundle = join(root, `${name}.app`);
  await mkdir(join(bundle, "Resources"), { recursive: true });
  await mkdir(join(bundle, "Assets.xcassets"));
  await writeFile(
    join(bundle, "Info.plist"),
    build({ CFBundleIdentifier: `org.example.${name.toLowerCase()}` }),
  );
  await writeFile(
    join(bundle, "Resources", "Archive.plist"),
    build({
      $archiver: "NSKeyedArchiver",
      $version: 100000,
      $objects: ["$null", "resource-only-value"],
      $top: { root: { UID: 1 } },
    }),
  );
  return bundle;
};

const cliScenarios = (bundle: string) =>
  [
    { operation: "inspect_plist", arguments: ["inspect-plist", bundle] },
    {
      operation: "decode_interface_builder",
      arguments: ["decode-interface-builder", bundle],
    },
    {
      operation: "inspect_asset_catalog",
      arguments: ["inspect-asset-catalog", bundle],
    },
    {
      operation: "inspect_keyed_archive",
      arguments: ["inspect-keyed-archive", bundle, "Resources/Archive.plist"],
    },
  ] as const;

const expectResourceEvidence = (
  value: unknown,
  operation: (typeof resourceOperations)[number],
  bundle: string,
) => {
  const evidence = parseEvidence(
    toolContract(operation).outputSchema.parse(value),
  );
  expect(evidence).toMatchObject({
    operation,
    subject: null,
    normalized_result: {
      resource_root: {
        caller_path: bundle,
        canonical_path: bundle,
        executable_sha256: null,
      },
    },
  });
  if (operation === "inspect_plist")
    expect(evidence.normalized_result).toMatchObject({
      source_path: join(bundle, "Info.plist"),
      bundle: { executable: null },
    });
  else
    expect(evidence.normalized_result).toMatchObject({ target_sha256: null });
  return evidence;
};
