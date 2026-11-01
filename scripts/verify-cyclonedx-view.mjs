#!/usr/bin/env node
// Projects Go and cargo-auditable binaries through inspect_analysis_view and
// checks the CycloneDX 1.6 document against the pinned official schema plus
// @cyclonedx/cyclonedx-library. The schema and the library stay in this run.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { withVerifierCleanup } from "./lib/verifier-cleanup.mjs";
import { importVerifierSource } from "./lib/verifier-source-loader.mjs";
import { createVerifierCommands } from "./lib/verify-commands.mjs";

const { inspectAnalysisView } = await importVerifierSource(
  new URL(
    "../src/application/analysisView/AnalysisViewService.ts",
    import.meta.url,
  ).href,
  import.meta.url,
);
const { createGoBinaryService } = await importVerifierSource(
  new URL("../src/composition/go.ts", import.meta.url).href,
  import.meta.url,
);
const { createRustBinaryService } = await importVerifierSource(
  new URL("../src/composition/rust.ts", import.meta.url).href,
  import.meta.url,
);
const { cargoPackageUrl, golangPackageUrl } = await importVerifierSource(
  new URL("../src/domain/packageUrl.ts", import.meta.url).href,
  import.meta.url,
);
const { PrivateRuntimeRoot } = await importVerifierSource(
  new URL("../src/process/PrivateRuntimeRoot.ts", import.meta.url).href,
  import.meta.url,
);

const require = createRequire(import.meta.url);
const Ajv = require("ajv");
const addFormats = require("ajv-formats");

const SCHEMA_BASE =
  "https://raw.githubusercontent.com/CycloneDX/specification/1.6.1/schema/";
const SCHEMA_FILES = [
  {
    name: "spdx.schema.json",
    sha256: "c41917196639055e9f9670811bac23ef777732144f3ff5a2f39686f61580dbe6",
  },
  {
    name: "jsf-0.82.schema.json",
    sha256: "8bae002c25e723db7ee1f26afde680ae1a2b1a8f6b4b4b0fd65dc3becb090aae",
  },
  {
    name: "bom-1.6.schema.json",
    sha256: "efc54d749e32a6e16abd19394b80b4c67d846e12c782e04505130375f94ea541",
  },
];
const LIBRARY_VERSION = "10.3.0";
const SCHEMA_FETCH_TIMEOUT_MS = 120_000;
// The pinned bom-1.6 schema is 262597 bytes. Stop before an unbounded body.
const SCHEMA_MAX_BYTES = 512 * 1024;

const commands = await createVerifierCommands();
const run = (command, args, options = {}) =>
  commands.exec(command, args, {
    timeout: 120_000,
    maxBuffer: 8 * 1024 * 1024,
    ...options,
  });

const readBoundedBody = async (response, name) => {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const bytes = Number(declared);
    if (Number.isSafeInteger(bytes) && bytes > SCHEMA_MAX_BYTES) {
      await response.body?.cancel()?.catch(() => undefined);
      throw new Error(
        `CycloneDX schema response for ${name} declares ${declared} bytes, ` +
          `above the ${SCHEMA_MAX_BYTES} byte limit.`,
      );
    }
  }
  const reader = response.body?.getReader();
  if (reader === undefined)
    throw new Error(`CycloneDX schema response for ${name} has no body.`);
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > SCHEMA_MAX_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new Error(
          `CycloneDX schema response for ${name} exceeds ${SCHEMA_MAX_BYTES} bytes.`,
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
};

const commandVersion = async (command, args) => {
  try {
    return (await run(command, args, { timeout: 15_000 })).stdout.trim();
  } catch {
    return null;
  }
};

const projectDocument = async (evidence) => {
  const projected = await inspectAnalysisView({
    source: { kind: "inline", evidence },
    view: { kind: "cyclonedx" },
  });
  if (!projected.ok) throw projected.error;
  const result = projected.value.normalized_result;
  if (result?.kind !== "cyclonedx")
    throw new Error("inspect_analysis_view did not return a CycloneDX view.");
  return { evidence: projected.value, result, document: result.document };
};

const assertProjection = async (evidence) => {
  const first = await projectDocument(evidence);
  const second = await projectDocument(evidence);
  const bytes = JSON.stringify(first.document);
  assert.equal(bytes, JSON.stringify(second.document));
  assert.equal(first.evidence.confidence, "derived");
  assert.equal(bytes.includes('"timestamp"'), false);
  assert.equal(bytes.includes('"aggregate":"complete"'), false);
  const aggregate = first.document.compositions?.[0]?.aggregate;
  assert.ok(aggregate === "incomplete" || aggregate === "unknown");
  return { ...first, bytes };
};

const root = await PrivateRuntimeRoot.create({
  prefix: "rea-cyclonedx-view-",
});
const report = {
  node: process.version,
  schema: null,
  ajv: null,
  consumer: null,
  go: null,
  rust: null,
  cyclonedxCli: null,
};

await withVerifierCleanup(async () => {
  const loaded = [];
  for (const file of SCHEMA_FILES) {
    const url = `${SCHEMA_BASE}${file.name}`;
    const response = await fetch(url, {
      signal: AbortSignal.timeout(SCHEMA_FETCH_TIMEOUT_MS),
    });
    if (!response.ok)
      throw new Error(
        `CycloneDX schema fetch failed for ${file.name}: ${response.status} ${response.statusText}`,
      );
    const schemaBytes = await readBoundedBody(response, file.name);
    const digest = createHash("sha256").update(schemaBytes).digest("hex");
    if (digest !== file.sha256)
      throw new Error(
        `CycloneDX schema digest for ${file.name} was ${digest}, expected ${file.sha256}.`,
      );
    loaded.push({
      url,
      sha256: digest,
      bytes: schemaBytes.byteLength,
      schema: JSON.parse(schemaBytes.toString("utf8")),
    });
  }
  report.schema = loaded.map(({ url, sha256, bytes }) => ({
    url,
    sha256,
    bytes,
  }));
  const ajv = new Ajv({ allErrors: true, strict: false, logger: false });
  addFormats(ajv);
  for (const file of loaded.slice(0, -1)) ajv.addSchema(file.schema);
  const validate = ajv.compile(loaded.at(-1).schema);
  const accept = (document) => {
    const parsed = JSON.parse(JSON.stringify(document));
    if (validate(parsed)) return null;
    return ajv.errorsText(validate.errors, { separator: "\n" });
  };

  const consumerDir = join(root.path, "consumer");
  await mkdir(consumerDir);
  await writeFile(
    join(consumerDir, "package.json"),
    `${JSON.stringify({ name: "rea-cyclonedx-consumer", private: true })}\n`,
  );
  await run(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--engine-strict=false",
      `@cyclonedx/cyclonedx-library@${LIBRARY_VERSION}`,
      "ajv@8.20.0",
      "ajv-formats@3.0.1",
      "ajv-formats-draft2019@1.6.1",
    ],
    { cwd: consumerDir, timeout: 180_000 },
  );
  const consumerRequire = createRequire(join(consumerDir, "package.json"));
  const { JsonValidator } = consumerRequire(
    "@cyclonedx/cyclonedx-library/Validation",
  );
  const { Version } = consumerRequire("@cyclonedx/cyclonedx-library/Spec");
  const validator = new JsonValidator(Version.v1dot6);
  const ingest = async (document) => {
    const failure = await validator.validate(JSON.stringify(document));
    return failure === null ? null : JSON.stringify(failure);
  };
  report.consumer = {
    name: "@cyclonedx/cyclonedx-library",
    version: LIBRARY_VERSION,
    validator: "JsonValidator",
    specVersion: Version.v1dot6,
  };

  const goCompiler = process.env.REA_VERIFY_GO_COMMAND ?? "go";
  const goVersion = await commandVersion(goCompiler, ["version"]);
  if (goVersion === null)
    throw new Error(
      "verify:cyclonedx:view requires Go on PATH, or an absolute REA_VERIFY_GO_COMMAND. Go only builds the fixture.",
    );
  const goDir = join(root.path, "go");
  const depDir = join(goDir, "dep");
  await mkdir(depDir, { recursive: true });
  await writeFile(
    join(goDir, "go.mod"),
    "module example.com/tool\n\ngo 1.22\n\nrequire example.com/dep v0.0.0\n\nreplace example.com/dep => ./dep\n",
  );
  await writeFile(
    join(depDir, "go.mod"),
    "module example.com/dep\n\ngo 1.22\n",
  );
  await writeFile(
    join(depDir, "dep.go"),
    'package dep\n\nfunc Name() string { return "dep" }\n',
  );
  await writeFile(
    join(goDir, "main.go"),
    'package main\n\nimport "example.com/dep"\n\nfunc main() { println(dep.Name()) }\n',
  );
  const goBinary = join(root.path, "tool");
  const goHome = {
    GOPATH: join(root.path, "gopath"),
    GOCACHE: join(root.path, "gocache"),
    GOMODCACHE: join(root.path, "gomodcache"),
    GOTMPDIR: join(root.path, "gotmp"),
  };
  await Promise.all(
    Object.values(goHome).map((path) => mkdir(path, { recursive: true })),
  );
  const goEnvironment = {
    ...process.env,
    CGO_ENABLED: "0",
    GO111MODULE: "on",
    GOENV: "off",
    GOFLAGS: "",
    GOTOOLCHAIN: "local",
    GOWORK: "off",
    GOPROXY: "off",
    GOSUMDB: "off",
    ...goHome,
  };
  await run(
    goCompiler,
    ["build", "-trimpath", "-buildvcs=false", "-o", goBinary, "."],
    { cwd: goDir, env: goEnvironment, timeout: 120_000 },
  );
  const goService = createGoBinaryService();
  await withVerifierCleanup(async () => {
    const inspected = await goService.inspect({ path: goBinary });
    if (!inspected.ok) throw inspected.error;
    const projected = await assertProjection(inspected.value);
    const info = inspected.value.normalized_result.build_info;
    if (info === null)
      throw new Error("Go fixture produced no build information.");
    const recovered = [
      ...(info.module.main === null ? [] : [info.module.main]),
      ...info.module.dependencies,
    ];
    const directoryPath = (path) =>
      path === "." ||
      path === ".." ||
      path.startsWith("./") ||
      path.startsWith("../") ||
      path.startsWith(".\\") ||
      path.startsWith("..\\") ||
      path.startsWith("/") ||
      path.startsWith("\\") ||
      (path.length >= 2 && /[A-Za-z]/u.test(path[0]) && path[1] === ":");
    const expectedPurls = recovered.flatMap((module) => {
      const replacement = module.replacement;
      const local = replacement !== null && directoryPath(replacement.path);
      if (local) return [];
      const identity = replacement ?? module;
      return directoryPath(identity.path)
        ? []
        : [golangPackageUrl(identity.path, identity.version)];
    });
    assert.deepEqual(
      projected.document.components.flatMap((component) =>
        component.purl === undefined ? [] : [component.purl],
      ),
      expectedPurls,
    );
    const localReplacement = recovered.find(
      (module) =>
        module.replacement !== null && directoryPath(module.replacement.path),
    );
    assert.ok(localReplacement, "Go fixture should record a local replacement");
    const replaced = projected.document.components.find((component) =>
      component.properties?.some(
        (property) =>
          property.name === "rea:go:original" &&
          property.value ===
            golangPackageUrl(localReplacement.path, localReplacement.version),
      ),
    );
    assert.ok(replaced, "Go document should keep the replaced module");
    assert.deepEqual(
      ["rea:go:original-path", "rea:go:original-version"].map(
        (name) =>
          replaced.properties.find((property) => property.name === name)?.value,
      ),
      [localReplacement.path, localReplacement.version],
    );
    const documentText = JSON.stringify(projected.document);
    assert.equal(documentText.includes("pkg:golang/."), false);
    assert.equal(documentText.includes("pkg:golang//"), false);
    assert.equal(
      projected.document.components.some((component) => component.hashes),
      false,
    );
    for (const component of projected.document.components) {
      const sum = component.properties?.find(
        (property) => property.name === "rea:go:sum",
      );
      if (sum !== undefined) assert.equal(sum.value.startsWith("h1:"), true);
    }
    const schemaError = accept(projected.document);
    if (schemaError !== null)
      throw new Error(
        `Go document rejected by CycloneDX schema:\n${schemaError}`,
      );
    const consumerError = await ingest(projected.document);
    if (consumerError !== null)
      throw new Error(
        `Go document rejected by @cyclonedx/cyclonedx-library:\n${consumerError}`,
      );
    report.go = {
      compiler: goVersion,
      aggregate: projected.document.compositions[0].aggregate,
      records: projected.result.source_coverage.records,
      components: expectedPurls,
      replacements: recovered
        .filter((module) => module.replacement !== null)
        .map((module) => module.replacement.path),
      document_bytes: Buffer.byteLength(projected.bytes),
      schema: "accepted",
      consumer: "accepted",
      deterministic: true,
    };
  }, [() => goService.close()]);

  const rustc = await commandVersion("rustc", ["--version"]);
  const cargo = await commandVersion("cargo", ["--version"]);
  if (rustc === null || cargo === null) {
    report.rust = {
      status: "skipped",
      reason: "rustc or cargo is not on PATH.",
      rustc,
      cargo,
    };
  } else {
    let auditable = await commandVersion("cargo", ["auditable", "--version"]);
    let auditableRoot = null;
    if (auditable === null) {
      auditableRoot = join(root.path, "tools");
      await run(
        "cargo",
        ["install", "cargo-auditable", "--locked", "--root", auditableRoot],
        { timeout: 600_000 },
      );
      const installed = await run(
        "cargo",
        ["install", "--list", "--root", auditableRoot],
        { timeout: 30_000 },
      );
      auditable =
        installed.stdout
          .split("\n")
          .find((line) => line.startsWith("cargo-auditable "))
          ?.trim() ?? "cargo-auditable";
    }
    const rustDir = join(root.path, "rust");
    const leafDir = join(rustDir, "leaf");
    await mkdir(join(rustDir, "src"), { recursive: true });
    await mkdir(join(leafDir, "src"), { recursive: true });
    await writeFile(
      join(rustDir, "Cargo.toml"),
      '[package]\nname = "app"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\nleaf = { path = "leaf" }\n\n[build-dependencies]\nleaf = { path = "leaf" }\n',
    );
    await writeFile(
      join(rustDir, "build.rs"),
      'fn main() {\n    println!("{}", leaf::label());\n}\n',
    );
    await writeFile(
      join(rustDir, "src", "main.rs"),
      'fn main() {\n    println!("{}", leaf::label());\n}\n',
    );
    await writeFile(
      join(leafDir, "Cargo.toml"),
      '[package]\nname = "leaf"\nversion = "0.2.0"\nedition = "2021"\n',
    );
    await writeFile(
      join(leafDir, "src", "lib.rs"),
      'pub fn label() -> &\'static str { "leaf" }\n',
    );
    const rustEnvironment = {
      ...process.env,
      CARGO_TARGET_DIR: join(root.path, "rust-target"),
      ...(auditableRoot === null
        ? {}
        : {
            PATH: `${join(auditableRoot, "bin")}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`,
          }),
    };
    await run(
      "cargo",
      ["auditable", "build", "--manifest-path", join(rustDir, "Cargo.toml")],
      { cwd: rustDir, env: rustEnvironment, timeout: 180_000 },
    );
    const rustBinary = join(
      root.path,
      "rust-target",
      "debug",
      process.platform === "win32" ? "app.exe" : "app",
    );
    const rustService = createRustBinaryService();
    await withVerifierCleanup(async () => {
      const inspected = await rustService.inspect({ path: rustBinary });
      if (!inspected.ok) throw inspected.error;
      const metadata = inspected.value.normalized_result.auditable_metadata;
      if (metadata === null)
        throw new Error(
          "cargo auditable fixture produced no embedded dependency metadata.",
        );
      const projected = await assertProjection(inspected.value);
      const expectedPurls = metadata.packages.map((pkg) =>
        pkg.source === "crates.io"
          ? cargoPackageUrl(pkg.name, pkg.version)
          : undefined,
      );
      assert.deepEqual(
        projected.document.components.map((component) => component.purl),
        expectedPurls,
      );
      metadata.packages.forEach((pkg, index) => {
        const scope = projected.document.components[index]?.scope;
        if (pkg.kind === "build") assert.equal(scope, "excluded");
        if (pkg.kind === "runtime") assert.equal(scope, "required");
        if (pkg.kind === null) assert.equal(scope, undefined);
      });
      const schemaError = accept(projected.document);
      if (schemaError !== null)
        throw new Error(
          `Rust document rejected by CycloneDX schema:\n${schemaError}`,
        );
      const consumerError = await ingest(projected.document);
      if (consumerError !== null)
        throw new Error(
          `Rust document rejected by @cyclonedx/cyclonedx-library:\n${consumerError}`,
        );
      report.rust = {
        status: "verified",
        rustc,
        cargo,
        auditable,
        packages: metadata.packages.map((pkg) => ({
          name: pkg.name,
          version: pkg.version,
          kind: pkg.kind,
        })),
        aggregate: projected.document.compositions[0].aggregate,
        records: projected.result.source_coverage.records,
        document_bytes: Buffer.byteLength(projected.bytes),
        schema: "accepted",
        consumer: "accepted",
        deterministic: true,
      };
    }, [() => rustService.close()]);
  }

  const cli = await commandVersion("cyclonedx-cli", ["--version"]);
  report.cyclonedxCli =
    cli === null ? { status: "absent" } : { status: "present", version: cli };
  report.ajv = { version: "8.20.0", formats: "3.0.1", strict: false };
}, [
  // A failed process stop retains its owner and leaves the root in place.
  async () => {
    await commands.close();
    await root.close();
  },
]);

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
