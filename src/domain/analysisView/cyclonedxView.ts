import { win32 } from "node:path";
import { z } from "zod";
import { digestSchema } from "../digests.js";
import {
  AnalysisResourceConstraintError,
  AnalysisUnsupportedTargetError,
} from "../analysisErrorCore.js";
import { fixedAllowanceOptions } from "../fixedAllowanceRemediation.js";
import type { GoModule } from "../go/goBinary.js";
import { goBinarySchema } from "../go/goBinary.js";
import { PRODUCT_IDENTITY } from "../../identity.js";
import { cargoPackageUrl, golangPackageUrl } from "../packageUrl.js";
import { err, ok, type Result } from "../result.js";
import type { RustPackage } from "../rust/rustBinary.js";
import { rustBinarySchema } from "../rust/rustBinary.js";
import type { AnalysisError } from "../analysisErrorBase.js";
import {
  boundedViewMessages,
  completeWithinViewCoverage,
} from "./analysisViewCoverage.js";
import {
  INSPECT_ANALYSIS_VIEW_OPERATION,
  analysisViewInputError,
} from "./analysisViewErrors.js";
import {
  createAnalysisViewResultReader,
  parentArtifactPath,
  type AnalysisViewParent,
} from "./analysisViewParent.js";
import { goBinaryUnknowns } from "./goBinaryView.js";
import { requireMetadataReportSubject } from "./metadataReportSubject.js";
import { rustBinaryUnknowns } from "./rustBinaryView.js";

/** Serialized CycloneDX JSON allowance. This view does not page. */
export const CYCLONEDX_DOCUMENT_BYTE_LIMIT = 1_048_576;

const COMPOSITION_LIMITATION =
  "The CycloneDX composition aggregate is incomplete or unknown. An embedded record does not establish that nothing else is linked.";
const GO_GRAPH_LIMITATION =
  "Go build information carries no module graph. Dependency entries are main-module to module edges only.";
const RUST_KIND_LIMITATION =
  "An omitted cargo package kind is not stored as runtime. An omitted CycloneDX scope does not claim the package is required.";

const propertySchema = z.strictObject({
  name: z.string().min(1),
  value: z.string(),
});
const componentSchema = z.strictObject({
  type: z.enum(["file", "library", "application"]),
  "bom-ref": z.string().min(1),
  name: z.string().min(1),
  version: z.string().min(1).max(1024).exactOptional(),
  purl: z.string().min(1).exactOptional(),
  scope: z.enum(["required", "excluded"]).exactOptional(),
  hashes: z
    .array(
      z.strictObject({
        alg: z.literal("SHA-256"),
        content: digestSchema,
      }),
    )
    .min(1)
    .exactOptional(),
  properties: z.array(propertySchema).min(1).exactOptional(),
});
const dependencySchema = z.strictObject({
  ref: z.string().min(1),
  dependsOn: z.array(z.string().min(1)),
});

/** One CycloneDX 1.6 document projected from a single parent. */
export const cycloneDxDocumentSchema = z.strictObject({
  bomFormat: z.literal("CycloneDX"),
  specVersion: z.literal("1.6"),
  serialNumber: z
    .string()
    .regex(
      /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u,
    ),
  version: z.literal(1),
  metadata: z.strictObject({
    component: componentSchema,
    tools: z.strictObject({
      components: z.array(componentSchema).min(1),
    }),
  }),
  components: z.array(componentSchema),
  dependencies: z.array(dependencySchema).min(1).exactOptional(),
  compositions: z
    .array(
      z.strictObject({
        aggregate: z.enum(["incomplete", "unknown"]),
        assemblies: z.array(z.string().min(1)).min(1),
        dependencies: z.array(z.string().min(1)).min(1).exactOptional(),
      }),
    )
    .min(1),
  properties: z.array(propertySchema).min(1),
});

/** Caller-selected CycloneDX projection. The document is the whole view. */
export const cycloneDxViewRequestSchema = z.strictObject({
  kind: z.literal("cyclonedx"),
});

/** Aggregate follows the producer. Records name whether an embedded list was present. */
export const cycloneDxSourceCoverageSchema = z.strictObject({
  aggregate: z.enum(["incomplete", "unknown"]),
  records: z.enum(["absent", "partial", "present"]),
});

type CycloneDxDocument = z.output<typeof cycloneDxDocumentSchema>;
type CycloneDxProperty = z.output<typeof propertySchema>;
type SourceCoverage = z.output<typeof cycloneDxSourceCoverageSchema>;
type ReportSubject = {
  readonly artifact: { readonly path: string; readonly sha256: string };
  readonly limitations: readonly string[];
};
type GoModuleIdentity = {
  readonly path: string;
  readonly version: string;
  readonly sum: string | null;
};
/**
 * Component identity is the replacement when one is recorded, otherwise the
 * module. `original` is that module. Both keep the parsed path, version and
 * sum; a path that cannot name a Package URL does not drop the other fields.
 */
type PublishedGoModule = {
  readonly component: GoModuleIdentity;
  readonly original: GoModuleIdentity | null;
};

const CRATES_IO_SOURCE = "crates.io";

const parseGoReport = createAnalysisViewResultReader(goBinarySchema);
const parseRustReport = createAnalysisViewResultReader(rustBinarySchema);

/** UUID version 8 derived from the first 16 bytes of the parent Evidence digest. */
export const cycloneDxSerialNumber = (evidenceDigest: string): string => {
  const bytes = Buffer.alloc(16);
  Buffer.from(evidenceDigest.slice(0, 32), "hex").copy(bytes);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x80;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `urn:uuid:${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

/**
 * Final segment of a recorded artifact path. Windows separators count on every
 * host, so Evidence that names `C:\a\b.exe` produces the same component name
 * everywhere.
 */
const fileComponentName = (path: string): string => {
  const name = win32.basename(path);
  return name.length > 0 ? name : path;
};

const presentSum = (sum: string | null): string | undefined =>
  sum !== null && sum.length > 0 ? sum : undefined;

const bomRefsFor = (purls: readonly string[]): string[] => {
  const seen = new Map<string, number>();
  return purls.map((purl) => {
    const count = seen.get(purl) ?? 0;
    seen.set(purl, count + 1);
    return count === 0 ? purl : `${purl}#${String(count)}`;
  });
};

/** First-seen bom-refs, including a recorded self-edge. */
const uniqueRefs = (refs: readonly (string | undefined)[]): string[] => {
  const seen = new Set<string>();
  const selected: string[] = [];
  for (const ref of refs) {
    if (ref === undefined || seen.has(ref)) continue;
    seen.add(ref);
    selected.push(ref);
  }
  return selected;
};

/**
 * Go's directory-path syntax, checked the same way on every host: `.`, `..`,
 * `./`, `../`, a rooted path, or a Windows drive prefix. It is not a module path.
 */
const isGoDirectoryPath = (path: string): boolean =>
  path === "." ||
  path === ".." ||
  path.startsWith("./") ||
  path.startsWith("../") ||
  path.startsWith(".\\") ||
  path.startsWith("..\\") ||
  path.startsWith("/") ||
  path.startsWith("\\") ||
  /^[A-Za-z]:/u.test(path);

/** A path that can name a Package URL. Empty and directory paths cannot. */
const isGoModulePath = (path: string): boolean =>
  path.length > 0 && !isGoDirectoryPath(path);

/**
 * The parsed replacement is the component, including a directory or other
 * path that cannot name a Package URL. The recorded module stays the original.
 * Absence of a replacement leaves the module as the component.
 */
const publishedGoModule = (module: GoModule): PublishedGoModule => {
  const replacement = module.replacement;
  if (replacement === null) return { component: module, original: null };
  return { component: replacement, original: module };
};

/** Show an empty recorded path instead of dropping it from the unknown. */
const displayPath = (path: string): string => (path.length === 0 ? '""' : path);

const goIdentityUnknowns = (
  modules: readonly GoModule[],
  published: readonly PublishedGoModule[],
): string[] =>
  modules.flatMap((module, index) => {
    const item = published[index];
    if (item === undefined) return [];
    const messages: string[] = [];
    const componentIsModule = isGoModulePath(item.component.path);
    if (item.original !== null && !componentIsModule)
      messages.push(
        `Go replacement path ${displayPath(item.component.path)} has no module identity.`,
      );
    if (!isGoModulePath(module.path))
      messages.push(
        item.original !== null && componentIsModule
          ? `Go module path ${displayPath(module.path)} has no module identity; the replacement module is kept.`
          : `Go module path ${displayPath(module.path)} has no module identity.`,
      );
    return messages;
  });

const goComponentProperties = (
  published: PublishedGoModule,
): CycloneDxProperty[] => {
  const properties: CycloneDxProperty[] = [];
  const component = published.component;
  const sum = presentSum(component.sum);
  if (sum !== undefined) properties.push({ name: "rea:go:sum", value: sum });
  const original = published.original;
  if (original === null) return properties;
  properties.push({
    name: "rea:go:original",
    value: isGoModulePath(original.path)
      ? golangPackageUrl(original.path, original.version)
      : original.path,
  });
  const originalSum = presentSum(original.sum);
  if (originalSum !== undefined)
    properties.push({ name: "rea:go:original-sum", value: originalSum });
  // The component name is the replacement path, except an empty path, which
  // cannot be a CycloneDX name. Keep the recorded path either way.
  if (!isGoModulePath(component.path))
    properties.push({
      name: "rea:go:local-replacement",
      value: component.path,
    });
  return properties;
};

const libraryComponent = (
  bomRef: string,
  name: string,
  version: string,
  purl: string | undefined,
  properties: readonly CycloneDxProperty[],
  scope?: "required" | "excluded",
): CycloneDxDocument["components"][number] => ({
  type: "library",
  "bom-ref": bomRef,
  name: name.length > 0 ? name : (purl ?? bomRef),
  ...(version.length > 0 ? { version } : {}),
  ...(purl === undefined ? {} : { purl }),
  ...(scope === undefined ? {} : { scope }),
  ...(properties.length > 0 ? { properties: [...properties] } : {}),
});

const documentAllowanceExceeded = (bytes: number, bound: "" | "at least ") =>
  err(
    new AnalysisResourceConstraintError(
      INSPECT_ANALYSIS_VIEW_OPERATION,
      "transport",
      `The CycloneDX document is ${bound}${String(bytes)} bytes and exceeds the ${String(CYCLONEDX_DOCUMENT_BYTE_LIMIT)}-byte CycloneDX document allowance. This view does not page. Export the parent Evidence with export_evidence_bundle.`,
      { document_bytes: bytes, limit_bytes: CYCLONEDX_DOCUMENT_BYTE_LIMIT },
      fixedAllowanceOptions("The CycloneDX document allowance", "bytes"),
    ),
  );

const projectSizedDocument = (
  parent: AnalysisViewParent,
  view: z.output<typeof cycloneDxViewRequestSchema>,
  report: ReportSubject,
  parentOperation: "inspect_go_binary" | "inspect_rust_binary",
  sourceCoverage: SourceCoverage,
  unknownValues: readonly string[],
  requiredUnknowns: readonly string[],
  extraLimitations: readonly string[],
  components: CycloneDxDocument["components"],
  dependencies: CycloneDxDocument["dependencies"],
  documentProperties: readonly CycloneDxProperty[],
): Result<
  {
    readonly kind: "cyclonedx";
    readonly view: z.output<typeof cycloneDxViewRequestSchema>;
    readonly parent_evidence_id: string;
    readonly parent_operation: "inspect_go_binary" | "inspect_rust_binary";
    readonly parent_digest: string;
    readonly artifact: { readonly path: string; readonly sha256: string };
    readonly coverage: ReturnType<typeof completeWithinViewCoverage>;
    readonly limitations: string[];
    readonly unknowns: string[];
    readonly source_coverage: SourceCoverage;
    readonly document: CycloneDxDocument;
  },
  AnalysisError
> => {
  const unknowns = boundedViewMessages(
    unknownValues,
    parent.evidenceId,
    "unknowns",
    requiredUnknowns,
  );
  const limitations = boundedViewMessages(
    [...extraLimitations, ...parent.limitations, ...report.limitations],
    parent.evidenceId,
    "limitations",
  );
  const binaryRef = `sha256:${report.artifact.sha256}`;
  const componentRefs = components.map((component) => component["bom-ref"]);
  const draft = {
    bomFormat: "CycloneDX" as const,
    specVersion: "1.6" as const,
    serialNumber: cycloneDxSerialNumber(parent.evidenceId.slice(3)),
    version: 1 as const,
    metadata: {
      component: {
        type: "file" as const,
        "bom-ref": binaryRef,
        name: fileComponentName(report.artifact.path),
        hashes: [{ alg: "SHA-256" as const, content: report.artifact.sha256 }],
      },
      tools: {
        components: [
          {
            type: "application" as const,
            "bom-ref": `rea@${PRODUCT_IDENTITY.packageVersion}`,
            name: PRODUCT_IDENTITY.displayName,
            version: PRODUCT_IDENTITY.packageVersion,
          },
        ],
      },
    },
    components,
    ...(dependencies === undefined ? {} : { dependencies }),
    compositions: [
      {
        aggregate: sourceCoverage.aggregate,
        assemblies: [binaryRef],
        ...(componentRefs.length > 0 ? { dependencies: componentRefs } : {}),
      },
    ],
    properties: [
      { name: "rea:evidence_id", value: parent.evidenceId },
      ...documentProperties,
      ...unknowns.map((value) => ({ name: "rea:unknown", value })),
    ],
  };
  const parsedDocument = cycloneDxDocumentSchema.safeParse(draft);
  if (!parsedDocument.success)
    return err(
      analysisViewInputError([
        {
          path: ["document"],
          reason: "invalid_value",
          message:
            "Retained Evidence could not be represented as CycloneDX 1.6. A component version is longer than 1024 characters, or another document field is outside the specification.",
        },
      ]),
    );
  const document = parsedDocument.data;
  const bytes = Buffer.byteLength(JSON.stringify(document), "utf8");
  if (bytes > CYCLONEDX_DOCUMENT_BYTE_LIMIT)
    return documentAllowanceExceeded(bytes, "");
  return ok({
    kind: "cyclonedx" as const,
    view,
    parent_evidence_id: parent.evidenceId,
    parent_operation: parentOperation,
    parent_digest: parent.evidenceId.slice(3),
    artifact: { path: report.artifact.path, sha256: report.artifact.sha256 },
    coverage: completeWithinViewCoverage(components.length, components.length),
    limitations,
    unknowns,
    source_coverage: sourceCoverage,
    document,
  });
};

const projectGoCycloneDx = (
  parent: AnalysisViewParent,
  view: z.output<typeof cycloneDxViewRequestSchema>,
): Result<
  ReturnType<typeof projectSizedDocument> extends Result<
    infer Value,
    AnalysisError
  >
    ? Value
    : never,
  AnalysisError
> => {
  const parsed = parseGoReport(parent);
  if (!parsed.ok) return parsed;
  const report = parsed.value;
  const subject = requireMetadataReportSubject(
    parent,
    report,
    "Go parent subject must identify the report's exact artifact.",
  );
  if (!subject.ok) return subject;
  const info = report.build_info;
  const modules = [
    ...(info?.module.main === null || info === null ? [] : [info.module.main]),
    ...(info?.module.dependencies ?? []),
  ];
  const published = modules.map(publishedGoModule);
  const refKeys = published.map((item, index) =>
    isGoModulePath(item.component.path)
      ? golangPackageUrl(item.component.path, item.component.version)
      : `go-module:${String(index)}`,
  );
  const refs = bomRefsFor(refKeys);
  const components = modules.map((module, index) => {
    const item = published[index];
    const ref = refs[index] ?? refKeys[index] ?? `go-module:${String(index)}`;
    if (item === undefined)
      return libraryComponent(ref, module.path, module.version, undefined, []);
    const component = item.component;
    return libraryComponent(
      ref,
      component.path,
      component.version,
      isGoModulePath(component.path) ? refKeys[index] : undefined,
      goComponentProperties(item),
    );
  });
  const mainRef =
    info?.module.main === null || info === null ? undefined : refs[0];
  const dependencyRefs = mainRef === undefined ? [] : refs.slice(1);
  // Empty dependsOn claims absence. That claim is valid only when every module line parsed.
  const dependencies =
    mainRef === undefined ||
    (info?.module.complete === false && dependencyRefs.length === 0)
      ? undefined
      : [
          {
            ref: mainRef,
            dependsOn: uniqueRefs(dependencyRefs),
          },
        ];
  const moduleRecordDecoded =
    info !== null &&
    (info.module.main !== null || info.module.dependencies.length > 0);
  const sourceCoverage: SourceCoverage =
    info === null || (info.module.complete && !moduleRecordDecoded)
      ? { aggregate: "unknown", records: "absent" }
      : info.module.complete
        ? { aggregate: "unknown", records: "present" }
        : { aggregate: "incomplete", records: "partial" };
  const reportedUnknowns = goBinaryUnknowns(report);
  return projectSizedDocument(
    parent,
    view,
    report,
    "inspect_go_binary",
    sourceCoverage,
    [...reportedUnknowns.values, ...goIdentityUnknowns(modules, published)],
    reportedUnknowns.required,
    [COMPOSITION_LIMITATION, GO_GRAPH_LIMITATION],
    components,
    dependencies,
    [{ name: "rea:go:graph", value: "main-module-edges" }],
  );
};

const rustScope = (
  kind: RustPackage["kind"],
): "required" | "excluded" | undefined =>
  kind === "build" ? "excluded" : kind === "runtime" ? "required" : undefined;

/** `pkg:cargo` resolves to crates.io, so only a crates.io record may claim one. */
const cratesIoPackageUrl = (pkg: RustPackage): string | undefined =>
  pkg.source === CRATES_IO_SOURCE
    ? cargoPackageUrl(pkg.name, pkg.version)
    : undefined;

const rustIdentityUnknowns = (packages: readonly RustPackage[]): string[] =>
  packages.flatMap((pkg) =>
    pkg.source === CRATES_IO_SOURCE
      ? []
      : [
          `Rust package ${pkg.name} ${pkg.version} from source ${pkg.source} has no Package URL because pkg:cargo names a crates.io package.`,
        ],
  );

const projectRustCycloneDx = (
  parent: AnalysisViewParent,
  view: z.output<typeof cycloneDxViewRequestSchema>,
): ReturnType<typeof projectGoCycloneDx> => {
  const parsed = parseRustReport(parent);
  if (!parsed.ok) return parsed;
  const report = parsed.value;
  const subject = requireMetadataReportSubject(
    parent,
    report,
    "Rust parent subject must identify the report's exact artifact.",
  );
  if (!subject.ok) return subject;
  const packages = report.auditable_metadata?.packages ?? [];
  const purls = packages.map(cratesIoPackageUrl);
  const refKeys = packages.map(
    (_, index) => purls[index] ?? `rust-package:${String(index)}`,
  );
  const refs = bomRefsFor(refKeys);
  // Edges expand small indices into full refs, so a report inside its own limit
  // can describe a document far past V8's string limit. Count before expanding.
  const dependencyRefBytes = packages.reduce(
    (total, pkg) =>
      [...new Set(pkg.dependencies)].reduce(
        (sum, target) => sum + Buffer.byteLength(refs[target] ?? "", "utf8"),
        total,
      ),
    0,
  );
  if (dependencyRefBytes > CYCLONEDX_DOCUMENT_BYTE_LIMIT)
    return documentAllowanceExceeded(dependencyRefBytes, "at least ");
  const components = packages.map((pkg, index) =>
    libraryComponent(
      refs[index] ?? `rust-package:${String(index)}`,
      pkg.name,
      pkg.version,
      purls[index],
      [
        { name: "rea:cargo:source", value: pkg.source },
        {
          name: "rea:cargo:kind",
          value: pkg.kind ?? "omitted",
        },
      ],
      rustScope(pkg.kind),
    ),
  );
  const dependencies =
    packages.length === 0
      ? undefined
      : packages.map((pkg, index) => ({
          ref: refs[index] ?? `rust-package:${String(index)}`,
          dependsOn: uniqueRefs(pkg.dependencies.map((target) => refs[target])),
        }));
  const metadata = report.auditable_metadata;
  const reportedUnknowns = rustBinaryUnknowns(report);
  return projectSizedDocument(
    parent,
    view,
    report,
    "inspect_rust_binary",
    metadata === null
      ? { aggregate: "unknown", records: "absent" }
      : { aggregate: "unknown", records: "present" },
    [...reportedUnknowns.values, ...rustIdentityUnknowns(packages)],
    reportedUnknowns.required,
    [COMPOSITION_LIMITATION, RUST_KIND_LIMITATION],
    components,
    dependencies,
    [],
  );
};

/** Project one Go or Rust parent into one deterministic CycloneDX 1.6 document. */
export const projectCycloneDxView = (
  parent: AnalysisViewParent,
  view: z.output<typeof cycloneDxViewRequestSchema>,
) => {
  if (parent.operation === "inspect_go_binary")
    return projectGoCycloneDx(parent, view);
  if (parent.operation === "inspect_rust_binary")
    return projectRustCycloneDx(parent, view);
  return err(
    new AnalysisUnsupportedTargetError(
      INSPECT_ANALYSIS_VIEW_OPERATION,
      parentArtifactPath(parent),
      `View cyclonedx is unsupported for parent operation ${parent.operation}; cyclonedx requires inspect_go_binary or inspect_rust_binary.`,
    ),
  );
};
