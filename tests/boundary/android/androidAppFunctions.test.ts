import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";
import { expect, it, vi } from "vitest";
import {
  ANDROID_APP_FUNCTIONS_LIMITS,
  extractAndroidAppFunctionManifestBindings,
  parseAndroidAppFunctionXml,
  projectAndroidAppFunctions,
  readAndroidAppFunctionAssets,
} from "../../../src/android/AndroidAppFunctions.js";
import { parseAndroidManifestComponents } from "../../../src/android/AndroidManifestComponents.js";
import { analyzeJadxRequest } from "../../../src/android/JadxAnalysis.js";
import { JadxInterruption } from "../../../src/android/JadxInterruption.js";
import { ArtifactResourceScope } from "../../../src/artifacts/ArtifactResourceScope.js";
import { ZipArtifactReader } from "../../../src/artifacts/ZipArtifactReader.js";
import { AnalysisCancelledError } from "../../../src/domain/analysisErrorCore.js";
import { projectAnalysisError } from "../../../src/domain/analysisErrorProjection.js";
import { androidResultSchemas } from "../../../src/domain/android/androidAnalysis.js";
import type { AndroidAppFunctionAssetCheckpoint } from "../../../src/domain/android/androidAppFunctions.js";
import { androidPartialObservationSchema } from "../../../src/domain/android/androidPartialObservation.js";
import {
  androidAppFunctionsViewResultSchema,
  projectAnalysisView,
} from "../../../src/domain/analysisView/analysisView.js";
import { createEvidence } from "../../../src/domain/evidence.js";
import { jsonValueByteLength } from "../../../src/domain/jsonValueByteLength.js";
import type { JsonValue } from "../../../src/domain/jsonValue.js";
import {
  createJadxProtocolFixture,
  verifyJadxFixtureCleanup,
} from "../../fixtures/android/jadx.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const writeSyntheticApk = async (
  apkPath: string,
  entries: readonly {
    readonly path: string;
    readonly bytes?: Uint8Array | string;
    readonly directory?: boolean;
  }[],
): Promise<void> => {
  const writer = new ZipWriter(new Uint8ArrayWriter());
  for (const entry of entries) {
    const raw =
      entry.bytes === undefined
        ? new Uint8Array(0)
        : typeof entry.bytes === "string"
          ? Buffer.from(entry.bytes, "utf8")
          : entry.bytes;
    await writer.add(
      entry.path,
      entry.directory === true ? undefined : new Uint8ArrayReader(raw),
      {
        directory: entry.directory === true,
        lastModDate: new Date("2025-01-01T00:00:00Z"),
      },
    );
  }
  await writeFile(apkPath, await writer.close());
};

const scanApkAssets = async (
  apkPath: string,
  referencedPaths: readonly string[],
  onObservation: (
    checkpoint: AndroidAppFunctionAssetCheckpoint,
  ) => void = () => {},
) => {
  const scope = new ArtifactResourceScope();
  try {
    return await readAndroidAppFunctionAssets({
      snapshot: apkPath,
      referencedPaths,
      resources: scope,
      signal: new AbortController().signal,
      interruption: (reason) =>
        new AnalysisCancelledError("inspect_android_package", {
          cause: reason,
        }),
      onObservation,
    });
  } finally {
    await scope.close();
  }
};

const projectManifestAndApk = async (manifestXml: string, apkPath: string) => {
  const components = parseAndroidManifestComponents(
    manifestXml,
    "complete",
    "36",
  );
  const bindings = extractAndroidAppFunctionManifestBindings(components);
  const assets = await scanApkAssets(apkPath, bindings.referencedAssetPaths);
  return projectAndroidAppFunctions(bindings, assets);
};

const engine = {
  name: "jadx-headless-mcp",
  version: "0.7.1",
  artifact_sha256: "a".repeat(64),
  source_revision: null,
  worker_count: 1,
  heap_limit_mib: 512,
};

it("extracts AppFunctionService bindings, permission checks, and bundled v2 XML schema functions", async () => {
  const root = await createTestTempDirectory("rea-appfunctions-v2-");
  const apk = join(root, "notes.apk");
  const schemaXml = `<?xml version="1.0" encoding="utf-8"?>
<appfunctions>
  <appfunction>
    <id>com.example.notes#createNote</id>
    <schema_name>createNote</schema_name>
    <schema_category>notes</schema_category>
    <schema_version>2</schema_version>
    <enabled_by_default>true</enabled_by_default>
    <parameters>
      <item><name>title</name></item>
    </parameters>
  </appfunction>
  <AppFunctionMetadata
    functionId="com.example.notes#findNotes"
    enabledByDefault="false">
    <schema name="findNotes" category="notes" version="1" />
  </AppFunctionMetadata>
  <item
    function_id="com.example.notes#archiveNote"
    schemaName="archiveNote"
    schemaCategory="notes"
    schemaVersion="3"
    enabled_by_default="true" />
</appfunctions>
`;
  const expectedSha256 = createHash("sha256")
    .update(Buffer.from(schemaXml, "utf8"))
    .digest("hex");
  await writeSyntheticApk(apk, [
    { path: "AndroidManifest.xml", bytes: "<manifest/>" },
    { path: "classes.dex", bytes: "dex" },
    { path: "assets/app_functions_v2.xml", bytes: schemaXml },
  ]);

  const manifestXml = `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="com.example.notes">
  <application>
    <service
      android:name=".AgentAppFunctionService"
      android:exported="true"
      android:permission="android.permission.BIND_APP_FUNCTION_SERVICE">
      <intent-filter>
        <action android:name="android.app.appfunctions.AppFunctionService" />
      </intent-filter>
      <property
        android:name="android.app.appfunctions"
        android:value="assets/app_functions_v2.xml" />
    </service>
  </application>
</manifest>`;

  const report = androidResultSchemas.inspect_android_package.parse(
    await analyzeJadxRequest(
      {
        json: () =>
          Promise.resolve({
            package: "com.example.notes",
            version_name: "1.0.0",
            version_code: "10",
            min_sdk: "34",
            target_sdk: "36",
            permissions: [],
          }),
        text: () => Promise.resolve(manifestXml),
        listClasses: () => Promise.reject(new Error("Unexpected class query")),
      },
      {
        operation: "inspect_android_package",
        input: { path: apk },
      },
      {
        loaded: {
          state: "LOADED",
          apk_path: apk,
          class_count: 4,
          resource_count: 2,
          threads: 1,
          resources: "full",
        },
        engine,
        appFunctionsAssets: (manifestBindings) =>
          scanApkAssets(apk, manifestBindings.referencedAssetPaths),
      },
    ),
  );

  expect(report.app_functions.status).toBe("complete");
  expect(report.app_functions.services).toEqual([
    {
      declared_name: ".AgentAppFunctionService",
      name: "com.example.notes.AgentAppFunctionService",
      declaration_index: 0,
      location: expect.objectContaining({ line: 4 }),
      exported: true,
      permission: "android.permission.BIND_APP_FUNCTION_SERVICE",
      binds_system_permission: true,
      declares_service_action: true,
      schema_pointers: [
        {
          source: "property",
          name: "android.app.appfunctions",
          value: "assets/app_functions_v2.xml",
          resource: null,
          resolved_asset_path: "assets/app_functions_v2.xml",
          location: expect.objectContaining({ line: 11 }),
        },
      ],
    },
  ]);
  expect(report.app_functions.schemas).toEqual([
    {
      path: "assets/app_functions_v2.xml",
      source_path: "assets/app_functions_v2.xml",
      sha256: expectedSha256,
      size: Buffer.byteLength(schemaXml, "utf8"),
      status: "complete",
      functions: [
        {
          id: "com.example.notes#createNote",
          schema_name: "createNote",
          schema_category: "notes",
          schema_version: "2",
          enabled_by_default: true,
        },
        {
          id: "com.example.notes#findNotes",
          schema_name: "findNotes",
          schema_category: "notes",
          schema_version: "1",
          enabled_by_default: false,
        },
        {
          id: "com.example.notes#archiveNote",
          schema_name: "archiveNote",
          schema_category: "notes",
          schema_version: "3",
          enabled_by_default: true,
        },
      ],
      limitations: [],
    },
  ]);
  expect(report.app_functions.limitations).toEqual([
    "Static AppFunction declarations and XML schema assets do not establish runtime registration, caller authorization, or execution.",
  ]);
});

it("resolves relative asset filenames, companion XSD pointers, and wildcard assets/*app_function*.xml files", async () => {
  const root = await createTestTempDirectory("rea-appfunctions-relative-");
  const apk = join(root, "relative.apk");
  await writeSyntheticApk(apk, [
    {
      path: "assets/custom_service_schema.xml",
      bytes:
        '<appfunctions><appfunction id="pkg#one" schema_name="one" schema_category="cat" schema_version="1" enabled_by_default="true"/></appfunctions>',
    },
    {
      path: "assets/nested/extra_App_Functions.XML",
      bytes:
        '<AppFunctionMetadata id="pkg#two" schemaName="two" schemaCategory="cat" schemaVersion="2" enabledByDefault="false"/>',
    },
    {
      path: "assets/app_functions_schema.xsd",
      bytes: "<xs:schema xmlns:xs='http://www.w3.org/2001/XMLSchema'/>",
    },
  ]);

  const components = parseAndroidManifestComponents(
    `<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="com.example.tasks">
      <application>
        <service android:name=".TaskFunctionService" android:exported="true">
          <property android:name="android.app.appfunctions.schema" android:value="app_functions_schema.xsd" />
          <meta-data android:name="android.app.appfunctions.v2" android:value="custom_service_schema.xml" />
        </service>
      </application>
    </manifest>`,
    "complete",
    "36",
  );
  const bindings = extractAndroidAppFunctionManifestBindings(components);
  expect(bindings.status).toBe("complete");
  expect(bindings.referencedAssetPaths).toEqual([
    "assets/custom_service_schema.xml",
  ]);
  expect(bindings.services[0]?.binds_system_permission).toBe(false);
  expect(bindings.services[0]?.declares_service_action).toBe(false);

  const assets = await scanApkAssets(apk, bindings.referencedAssetPaths);
  const inventory = projectAndroidAppFunctions(bindings, assets);
  expect(inventory.status).toBe("complete");
  expect(inventory.schemas.map((schema) => schema.path)).toEqual([
    "assets/custom_service_schema.xml",
    "assets/nested/extra_App_Functions.XML",
  ]);
  expect(
    inventory.schemas.flatMap((schema) => schema.functions.map((fn) => fn.id)),
  ).toEqual(["pkg#one", "pkg#two"]);
});

it("records service binding and explicit limitation when referencing a compiled @xml/... resource", async () => {
  const root = await createTestTempDirectory("rea-appfunctions-compiled-xml-");
  const apk = join(root, "compiled-xml.apk");
  await writeSyntheticApk(apk, [
    { path: "AndroidManifest.xml", bytes: "<manifest/>" },
    { path: "res/xml/app_functions.xml", bytes: "compiled-binary-xml" },
  ]);

  const inventory = await projectManifestAndApk(
    `<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="com.example.compiled">
      <application>
        <service
          android:name=".CompiledResourceAppFunctionService"
          android:exported="true"
          android:permission="android.permission.BIND_APP_FUNCTION_SERVICE">
          <intent-filter>
            <action android:name="android.app.appfunctions.AppFunctionService" />
          </intent-filter>
          <meta-data
            android:name="android.app.appfunctions"
            android:resource="@xml/app_functions" />
        </service>
      </application>
    </manifest>`,
    apk,
  );

  expect(inventory.status).toBe("partial");
  expect(inventory.services).toEqual([
    expect.objectContaining({
      name: "com.example.compiled.CompiledResourceAppFunctionService",
      exported: true,
      permission: "android.permission.BIND_APP_FUNCTION_SERVICE",
      binds_system_permission: true,
      declares_service_action: true,
      schema_pointers: [
        expect.objectContaining({
          source: "meta-data",
          name: "android.app.appfunctions",
          value: null,
          resource: "@xml/app_functions",
          resolved_asset_path: null,
        }),
      ],
    }),
  ]);
  expect(inventory.schemas).toEqual([]);
  expect(inventory.limitations.join(" ")).toContain("@xml/app_functions");
  expect(inventory.limitations.join(" ")).toContain(
    "compiled @xml/... resource targets are not decoded from assets/",
  );
});

it("handles malformed XML, DOCTYPE rejection, non-UTF-8 assets, missing referenced assets, and oversized XML caps deterministically", async () => {
  const doctypeResult = parseAndroidAppFunctionXml(
    '<?xml version="1.0"?><!DOCTYPE appfunctions [<!ENTITY x "y">]><appfunctions/>',
  );
  expect(doctypeResult).toEqual({
    status: "unavailable",
    functions: [],
    limitations: [
      "AppFunctions schema XML declares a DOCTYPE/DTD, which is rejected.",
    ],
  });

  const malformedResult = parseAndroidAppFunctionXml(
    "<appfunctions><appfunction>",
  );
  expect(malformedResult.status).toBe("unavailable");
  expect(malformedResult.limitations[0]).toContain("not well-formed");

  const root = await createTestTempDirectory("rea-appfunctions-hostile-");
  const apk = join(root, "hostile.apk");
  const oversizedXml = `<appfunctions>${" ".repeat(ANDROID_APP_FUNCTIONS_LIMITS.schemaAssetBytes + 64)}</appfunctions>`;
  await writeSyntheticApk(apk, [
    {
      path: "assets/doctype_app_functions.xml",
      bytes:
        '<?xml version="1.0"?><!DOCTYPE appfunctions><appfunctions><appfunction id="x"/></appfunctions>',
    },
    {
      path: "assets/malformed_app_functions.xml",
      bytes: "<appfunctions><broken>",
    },
    {
      path: "assets/invalid_utf8_app_functions.xml",
      bytes: new Uint8Array([0xff, 0xfe, 0xfd]),
    },
    {
      path: "assets/oversized_app_functions.xml",
      bytes: oversizedXml,
    },
    {
      path: "assets/valid_app_functions.xml",
      bytes:
        '<appfunctions><appfunction id="ok#fn" enabled_by_default="maybe"/></appfunctions>',
    },
  ]);

  const inventory = await projectManifestAndApk(
    `<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="com.example.hostile">
      <application>
        <service android:name=".HostileAppFunctionService" android:exported="false">
          <property android:name="android.app.appfunctions" android:value="assets/missing_schema.xml" />
        </service>
      </application>
    </manifest>`,
    apk,
  );

  expect(inventory.status).toBe("partial");
  expect(inventory.schemas).toHaveLength(5);
  const byPath = new Map(
    inventory.schemas.map((schema) => [schema.path, schema]),
  );
  expect(byPath.get("assets/doctype_app_functions.xml")?.status).toBe(
    "unavailable",
  );
  expect(
    byPath.get("assets/doctype_app_functions.xml")?.limitations.join(" "),
  ).toContain("DOCTYPE/DTD");
  expect(byPath.get("assets/malformed_app_functions.xml")?.status).toBe(
    "unavailable",
  );
  expect(byPath.get("assets/invalid_utf8_app_functions.xml")?.status).toBe(
    "unavailable",
  );
  expect(byPath.get("assets/oversized_app_functions.xml")).toMatchObject({
    status: "unavailable",
    sha256: null,
    size: null,
  });
  expect(byPath.get("assets/valid_app_functions.xml")).toMatchObject({
    status: "partial",
    functions: [
      {
        id: "ok#fn",
        schema_name: null,
        schema_category: null,
        schema_version: null,
        enabled_by_default: null,
      },
    ],
  });
  expect(inventory.limitations.join(" ")).toContain(
    "assets/missing_schema.xml was not found",
  );
});

it.skipIf(process.platform === "win32")(
  "returns empty AppFunctions on ordinary APKs and full inventory through JadxSession on AppFunctions APKs",
  async () => {
    const ordinary = await createJadxProtocolFixture("ordinary-apk");
    const ordinaryResult = await ordinary.service.execute(
      "inspect_android_package",
      { path: ordinary.apk },
    );
    if (!ordinaryResult.ok) throw ordinaryResult.error;
    const ordinaryParsed = androidResultSchemas.inspect_android_package.parse(
      ordinaryResult.value.normalized_result,
    );
    expect(ordinaryParsed.app_functions).toEqual({
      status: "complete",
      services: [],
      schemas: [],
      limitations: [],
    });
    await ordinary.provider.close();
    await verifyJadxFixtureCleanup(ordinary.launches);

    const appFnFixture = await createJadxProtocolFixture("app-functions");
    const v2Xml = `<?xml version="1.0" encoding="utf-8"?>
<appfunctions>
  <appfunction>
    <id>fixture#runAgentTask</id>
    <schema_name>runAgentTask</schema_name>
    <schema_category>automation</schema_category>
    <schema_version>1</schema_version>
    <enabled_by_default>true</enabled_by_default>
  </appfunction>
</appfunctions>`;
    await writeSyntheticApk(appFnFixture.apk, [
      { path: "AndroidManifest.xml", bytes: "<manifest/>" },
      { path: "classes.dex", bytes: "dex" },
      { path: "assets/app_functions_v2.xml", bytes: v2Xml },
    ]);
    const result = await appFnFixture.service.execute(
      "inspect_android_package",
      { path: appFnFixture.apk },
    );
    if (!result.ok) throw result.error;
    expect(result.value.locations).toEqual([
      { kind: "artifact-path", path: "AndroidManifest.xml" },
      { kind: "artifact-path", path: "assets/app_functions_v2.xml" },
    ]);
    const parsed = androidResultSchemas.inspect_android_package.parse(
      result.value.normalized_result,
    );
    expect(parsed.app_functions.status).toBe("complete");
    expect(parsed.app_functions.services).toHaveLength(1);
    expect(parsed.app_functions.services[0]).toMatchObject({
      name: "com.example.fixture.AgentAppFunctionService",
      binds_system_permission: true,
      declares_service_action: true,
    });
    expect(parsed.app_functions.schemas[0]?.functions).toEqual([
      {
        id: "fixture#runAgentTask",
        schema_name: "runAgentTask",
        schema_category: "automation",
        schema_version: "1",
        enabled_by_default: true,
      },
    ]);
    const view = projectAnalysisView(
      {
        predicateType: result.value.predicate_type,
        evidenceId: result.value.evidence_id,
        operation: result.value.operation,
        normalizedResult: result.value.normalized_result,
        subject: result.value.subject,
        limitations: result.value.limitations,
      },
      { kind: "android", facet: "app-functions" },
    );
    if (!view.ok) throw view.error;
    const facetResult = androidAppFunctionsViewResultSchema.parse(view.value);
    expect(facetResult.summary).toEqual({
      service_count: 1,
      system_bound_service_count: 1,
      schema_count: 1,
      function_count: 1,
    });
    await appFnFixture.provider.close();
    await verifyJadxFixtureCleanup(appFnFixture.launches);
  },
);

it("preserves completed schema facts and interrupted carrier in checkpoint when a later schema read is cancelled", async () => {
  const root = await createTestTempDirectory("rea-appfunctions-mid-cancel-");
  const apk = join(root, "mid-cancel.apk");
  const firstXml =
    '<appfunctions><appfunction id="pkg#completedFn" schema_name="completedFn" schema_version="1" enabled_by_default="true"/></appfunctions>';
  const secondXml =
    '<appfunctions><appfunction id="pkg#interruptedFn"/></appfunctions>';
  const thirdXml =
    '<appfunctions><appfunction id="pkg#unexaminedFn"/></appfunctions>';
  const firstSha256 = createHash("sha256")
    .update(Buffer.from(firstXml, "utf8"))
    .digest("hex");
  await writeSyntheticApk(apk, [
    { path: "assets/first_app_functions.xml", bytes: firstXml },
    { path: "assets/second_app_functions.xml", bytes: secondXml },
    { path: "assets/third_app_functions.xml", bytes: thirdXml },
  ]);

  const controller = new AbortController();
  const reason = { caller: "cancel-before-second-schema" };
  const originalOpen = ZipArtifactReader.prototype.open;
  const openSpy = vi
    .spyOn(ZipArtifactReader.prototype, "open")
    .mockImplementation(async function (
      this: ZipArtifactReader,
      entry,
      signal,
    ) {
      if (entry.path === "assets/second_app_functions.xml") {
        controller.abort(reason);
        throw new JadxInterruption(reason);
      }
      return originalOpen.call(this, entry, signal);
    });
  const scope = new ArtifactResourceScope();
  let checkpoint: AndroidAppFunctionAssetCheckpoint | undefined;
  try {
    let rejected: unknown;
    try {
      await readAndroidAppFunctionAssets({
        snapshot: apk,
        referencedPaths: [],
        resources: scope,
        signal: controller.signal,
        interruption: (cause) =>
          new AnalysisCancelledError("inspect_android_package", { cause }),
        onObservation: (observed) => {
          checkpoint = observed;
        },
      });
    } catch (cause: unknown) {
      rejected = cause;
    }

    expect(rejected).toBeInstanceOf(AnalysisCancelledError);
    expect((rejected as AnalysisCancelledError).cause).toBe(reason);
    if (checkpoint === undefined) throw new Error("Missing asset checkpoint");
    expect(checkpoint).toMatchObject({
      scan_state: "interrupted",
      status: "partial",
      examined_entries: 2,
    });
    expect(checkpoint.schemas).toHaveLength(2);
    expect(checkpoint.schemas[0]).toEqual({
      path: "assets/first_app_functions.xml",
      source_path: "assets/first_app_functions.xml",
      sha256: firstSha256,
      size: Buffer.byteLength(firstXml, "utf8"),
      status: "complete",
      functions: [
        {
          id: "pkg#completedFn",
          schema_name: "completedFn",
          schema_category: null,
          schema_version: "1",
          enabled_by_default: true,
        },
      ],
      limitations: [],
    });
    expect(checkpoint.schemas[1]).toMatchObject({
      path: "assets/second_app_functions.xml",
      sha256: null,
      size: null,
      status: "unavailable",
      functions: [],
    });
    expect(checkpoint.limitations.join(" ")).toContain(
      "remaining schema assets remain unknown",
    );

    const validPartial = {
      provider_id: "jadx" as const,
      operation: "inspect_android_package" as const,
      target: {
        selected_path: apk,
        path: apk,
        sha256: "a".repeat(64),
        format: "apk" as const,
      },
      provider_facts: {
        jar_sha256: null,
        bridge_sha256: null,
        bridge_name: "rea-jadx-bridge",
        bridge_version: "1",
        server_name: null,
        server_version: null,
        engine_version: null,
      },
      calls: [],
      app_functions: {
        manifest_status: "complete" as const,
        services: [],
        referenced_asset_paths: [],
        manifest_limitations: [],
        assets: checkpoint,
      },
    };
    expect(
      androidPartialObservationSchema.safeParse(validPartial).success,
    ).toBe(true);
    expect(
      androidPartialObservationSchema.safeParse({
        ...validPartial,
        operation: "inspect_android_jni_bindings",
      }).success,
    ).toBe(false);
  } finally {
    openSpy.mockRestore();
    await scope.close();
  }
});

it.skipIf(process.platform === "win32")(
  "retains completed AppFunctions services and XML schema facts in JadxSession partialObservation when ZIP reader close fails",
  async () => {
    const appFnFixture = await createJadxProtocolFixture("app-functions");
    const v2Xml =
      '<appfunctions><appfunction id="fixture#surviveCloseFailure" schema_name="surviveCloseFailure" schema_version="2" enabled_by_default="true"/></appfunctions>';
    const expectedSha256 = createHash("sha256")
      .update(Buffer.from(v2Xml, "utf8"))
      .digest("hex");
    await writeSyntheticApk(appFnFixture.apk, [
      { path: "AndroidManifest.xml", bytes: "<manifest/>" },
      { path: "classes.dex", bytes: "dex" },
      { path: "assets/app_functions_v2.xml", bytes: v2Xml },
    ]);

    const originalClose = ZipArtifactReader.prototype.close;
    let failFirstClose = true;
    const closeSpy = vi
      .spyOn(ZipArtifactReader.prototype, "close")
      .mockImplementation(async function (this: ZipArtifactReader) {
        if (failFirstClose) {
          failFirstClose = false;
          throw new Error("simulated ZIP reader close failure");
        }
        await originalClose.call(this);
      });
    try {
      const result = await appFnFixture.service.execute(
        "inspect_android_package",
        { path: appFnFixture.apk },
      );
      if (result.ok)
        throw new Error("Expected ZIP reader close failure to reject");
      const projected = projectAnalysisError(result.error);
      expect(projected.code).toBe("cleanup_incomplete");
      const partial = androidPartialObservationSchema.parse(
        result.error.partialObservation,
      );
      expect(partial.app_functions?.manifest_status).toBe("complete");
      expect(partial.app_functions?.services).toHaveLength(1);
      expect(partial.app_functions?.services[0]?.name).toBe(
        "com.example.fixture.AgentAppFunctionService",
      );
      expect(partial.app_functions?.assets).toMatchObject({
        scan_state: "completed",
        status: "complete",
        schemas: [
          {
            path: "assets/app_functions_v2.xml",
            sha256: expectedSha256,
            size: Buffer.byteLength(v2Xml, "utf8"),
            status: "complete",
            functions: [
              {
                id: "fixture#surviveCloseFailure",
                schema_name: "surviveCloseFailure",
                schema_category: null,
                schema_version: "2",
                enabled_by_default: true,
              },
            ],
          },
        ],
      });
    } finally {
      closeSpy.mockRestore();
      await appFnFixture.provider.close();
      await verifyJadxFixtureCleanup(appFnFixture.launches);
    }
  },
);

it("bounds unresolved pointer diagnostics using declaration_index so large service names never exceed the AppFunctions view budget", () => {
  const hugeLocalName = `.${"S".repeat(100 * 1024)}`;
  const pointersXml = Array.from(
    { length: 64 },
    (_, index) =>
      `<meta-data android:name="android.app.appfunctions" android:resource="@xml/fn_${String(index)}_${"r".repeat(220)}" />`,
  ).join("\n");
  const manifestXml = `<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="com.example.huge">
    <application>
      <service
        android:name="${hugeLocalName}"
        android:exported="true"
        android:permission="android.permission.BIND_APP_FUNCTION_SERVICE">
        ${pointersXml}
      </service>
    </application>
  </manifest>`;

  const components = parseAndroidManifestComponents(
    manifestXml,
    "complete",
    "36",
  );
  const bindings = extractAndroidAppFunctionManifestBindings(components);
  const inventory = projectAndroidAppFunctions(bindings, {
    status: "complete",
    examinedEntries: 1,
    schemas: [],
    limitations: [],
  });

  expect(inventory.services).toHaveLength(1);
  expect(inventory.services[0]?.schema_pointers).toHaveLength(64);
  expect(inventory.limitations[0]).toContain("Service at declaration_index 0");
  expect(
    inventory.limitations.some((message) => message.includes(hugeLocalName)),
  ).toBe(false);
  expect(inventory.limitations.join("\n")).toContain(
    "additional AppFunctions diagnostic message(s) omitted after reaching the",
  );
  const diagnosticBytes = Buffer.byteLength(
    inventory.limitations.join("\n"),
    "utf8",
  );
  expect(diagnosticBytes).toBeLessThanOrEqual(
    ANDROID_APP_FUNCTIONS_LIMITS.diagnosticBytes,
  );

  const packageReport = {
    engine,
    package_name: "com.example.huge",
    version_name: "1.0",
    version_code: "1",
    min_sdk: "34",
    target_sdk: "36",
    permissions: [],
    manifest: {
      status: "complete" as const,
      text: manifestXml,
      reported_total_bytes: Buffer.byteLength(manifestXml, "utf8"),
    },
    components,
    app_functions: inventory,
    class_count: 1,
    resource_count: 1,
    signature_verification: "not_performed" as const,
  };
  const evidence = createEvidence(
    { path: "/retained-huge.apk", sha256: "b".repeat(64), format: "apk" },
    { id: "jadx", name: "JADX", version: "0.7.1" },
    {
      operation: "inspect_android_package",
      parameters: {},
      result: packageReport as unknown as JsonValue,
      limitations: [],
    },
  );
  const projected = projectAnalysisView(
    {
      predicateType: evidence.predicate_type,
      evidenceId: evidence.evidence_id,
      operation: evidence.operation,
      normalizedResult: evidence.normalized_result,
      subject: evidence.subject,
      limitations: evidence.limitations,
    },
    { kind: "android", facet: "app-functions" },
  );
  if (!projected.ok) throw projected.error;
  const parsedView = androidAppFunctionsViewResultSchema.parse(projected.value);
  expect(parsedView.summary).toEqual({
    service_count: 1,
    system_bound_service_count: 1,
    schema_count: 0,
    function_count: 0,
  });
  expect(
    jsonValueByteLength(parsedView as unknown as JsonValue, 1024 * 1024),
  ).toBeLessThan(1024 * 1024);
});
