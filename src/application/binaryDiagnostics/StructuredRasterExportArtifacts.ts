import { fixedCeilingConstraint } from "../../domain/analysisErrorCore.js";
import {
  rasterExportResolvedControlsSchema,
  type StructuredRasterExportInput,
  type StructuredRasterExportResult,
} from "../../domain/native/structuredRasterExport.js";
import type { SelectedRasterSnapshot } from "./SelectedRasterSnapshotReader.js";
import {
  type Plan,
  type Prepared,
  invalid,
} from "./StructuredRasterExportPlan.js";
import {
  RASTER_EXPORT_LIMITS,
  RASTER_EXPORT_OPERATION,
  rasterExportCapacity,
  type RasterExportWriter,
} from "./RasterExportPublication.js";
import {
  preflightRasterResource,
  RASTER_RENDER_MAX_SOURCE_BYTES,
  RASTER_RENDER_MAX_WORKING_BYTES,
  copyRasterResourceRaw,
  renderRasterResource,
  prepareRasterRenderCoverage,
  type RasterRenderFailure,
} from "./RasterResourceRendering.js";
import { resolveRasterColorPolicy } from "./RasterRenderingSelection.js";
function failLimit(
  failure: Extract<RasterRenderFailure, { status: "limit-exceeded" }>,
): never {
  throw fixedCeilingConstraint(
    RASTER_EXPORT_OPERATION,
    "capacity",
    failure.reason,
    {
      name: failure.limit.name,
      kind: failure.limit.unit === "bytes" ? "bytes" : "count",
      limit: failure.limit.maximum,
      unit: failure.limit.unit,
      narrowing: "Select fewer resources or a smaller raster hypothesis.",
    },
  );
}
function encoded(text: string, remaining: number): Buffer {
  if (Buffer.byteLength(text) > remaining)
    throw rasterExportCapacity(
      "Raster export metadata exceeds remaining aggregate byte allowance.",
      "output_bytes",
    );
  return Buffer.from(text);
}
export function resolvedExportControls(
  input: StructuredRasterExportInput,
  prepared: Prepared,
  snapshot: SelectedRasterSnapshot,
) {
  const {
    path: _path,
    output_directory: _output,
    expected_sha256: _hash,
    segments,
    ...controls
  } = input;
  return rasterExportResolvedControlsSchema.parse({
    ...controls,
    length: snapshot.window.length,
    grammar: prepared.report.grammar,
    mapping_profile: segments ? "explicit-segments" : input.profile,
    logical_base: prepared.logical.logicalBase,
    segment_count: prepared.logical.segments.length,
  });
}
/** Admit renderer-owned allocation ceilings before creating any output. */
export function preflightExport(
  plans: Plan[],
  input: StructuredRasterExportInput,
  signal?: AbortSignal,
): void {
  if (!input.formats.includes("png")) return;
  for (const plan of plans) {
    signal?.throwIfAborted();
    if (
      !plan.layout ||
      !resolveRasterColorPolicy(input.color_policy, plan.registry, plan.layout)
    )
      continue;
    const result = preflightRasterResource(plan.layout);
    if (result.status === "limit-exceeded") failLimit(result);
  }
}
async function writeResources(
  writer: RasterExportWriter,
  prepared: Prepared,
  input: StructuredRasterExportInput,
  plans: Plan[],
  coverage: Extract<
    ReturnType<typeof prepareRasterRenderCoverage>,
    { status: "prepared" }
  >["coverage"],
  signal: AbortSignal | undefined,
): Promise<void> {
  for (let ordinal = 0; ordinal < plans.length; ordinal++) {
    signal?.throwIfAborted();
    const plan = plans[ordinal]!,
      outcome = plan.outcome;
    if (!plan.payload) continue;
    const base = `resource-${String(ordinal).padStart(4, "0")}-${outcome.descriptor_offset}-${outcome.hypothesis?.bits_per_pixel ?? 0}b-u${outcome.hypothesis?.offset_unit ?? 0}`;
    if (input.formats.includes("raw")) {
      if (writer.remainingBytes < 1)
        throw rasterExportCapacity(
          "No aggregate output bytes remain.",
          "output_bytes",
        );
      const raw = await copyRasterResourceRaw(
        prepared.logical.bytes,
        { payloadRange: plan.payload },
        {
          coverage,
          ...(signal ? { signal } : {}),
          maxOutputBytes: Math.min(
            writer.remainingBytes,
            RASTER_RENDER_MAX_SOURCE_BYTES,
          ),
        },
      );
      if (raw.status === "limit-exceeded") failLimit(raw);
      if (raw.status === "copied")
        outcome.files.raw = await writer.write(`${base}.raw`, raw.raw);
      else outcome.reason = raw.reason;
    }
    if (input.formats.includes("png")) {
      const policy = resolveRasterColorPolicy(
        input.color_policy,
        plan.registry,
        plan.layout,
      );
      if (!plan.layout || !policy)
        outcome.reason =
          outcome.reason ??
          "No supported admitted layout or selected registry palette; no colors were guessed.";
      else {
        if (writer.remainingBytes < 1)
          throw rasterExportCapacity(
            "No aggregate output bytes remain.",
            "output_bytes",
          );
        const rendered = await renderRasterResource(
          prepared.logical.bytes,
          plan.layout,
          policy,
          {
            coverage,
            ...(signal ? { signal } : {}),
            // Renderer allowance bounds transient working buffers, not disk bytes.
            // Publication separately admits the encoded PNG against aggregate output.
            maxOutputBytes: RASTER_RENDER_MAX_WORKING_BYTES,
          },
        );
        if (rendered.status === "limit-exceeded") failLimit(rendered);
        if (rendered.status === "rendered") {
          outcome.files.png = await writer.write(
            `${base}${policy.kind === "diagnostic-indices" ? ".diagnostic" : ""}.png`,
            rendered.png,
          );
          outcome.interpretation = rendered.interpretation;
        } else outcome.reason = rendered.reason;
      }
    }
    if (outcome.files.raw || outcome.files.png) outcome.status = "exported";
  }
}
/** Sequential full-resource publication. Mapping table is canonical, never duplicated in settings. */
export async function writeExport(
  writer: RasterExportWriter,
  {
    snapshot,
    prepared,
    input,
    plans,
    signal,
  }: {
    snapshot: SelectedRasterSnapshot;
    prepared: Prepared;
    input: StructuredRasterExportInput;
    plans: Plan[];
    signal: AbortSignal | undefined;
  },
): Promise<StructuredRasterExportResult> {
  signal?.throwIfAborted();
  const coverage = prepareRasterRenderCoverage(
    prepared.logical.bytes.length,
    prepared.logical.coverage,
    signal,
  );
  if (coverage.status === "limit-exceeded") failLimit(coverage);
  if (coverage.status !== "prepared")
    throw invalid("segments", coverage.reason);
  const resolved_controls = resolvedExportControls(input, prepared, snapshot);
  const chunks: string[] = [];
  let size = 0;
  for (const segment of prepared.logical.segments) {
    signal?.throwIfAborted();
    const line = JSON.stringify(segment) + "\n";
    size += Buffer.byteLength(line);
    if (size > writer.remainingBytes)
      throw rasterExportCapacity(
        "Normalized segment metadata exceeds the aggregate output allowance.",
        "output_bytes",
      );
    chunks.push(line);
  }
  const segments = await writer.write(
    "segments.jsonl",
    encoded(chunks.join(""), writer.remainingBytes),
  );
  await writeResources(
    writer,
    prepared,
    input,
    plans,
    coverage.coverage,
    signal,
  );
  const limitations = [
    ...prepared.report.limitations,
    ...(prepared.family?.limitations ?? []),
    ...prepared.logical.assumptions,
    "Exports only retained descriptors under the configured bounded scan; this is not complete firmware extraction.",
    "PNG uses stored-DEFLATE without compression. Explicit colors do not establish a current theme or reconstructed screen.",
    "Files may be visible before commit; this is not atomic directory rename. Windows inherits ACLs, not a POSIX privacy guarantee.",
  ];
  const discovery_complete =
      prepared.report.coverage.complete &&
      (input.resource_family === "generic"
        ? true
        : prepared.family?.coverage.complete === true),
    exported = plans.filter((p) => p.outcome.status === "exported").length;
  const manifest = await writer.write(
    "manifest.json",
    encoded(
      JSON.stringify(
        {
          schema_version: 1,
          source: snapshot.artifact,
          window: snapshot.window,
          settings: resolved_controls,
          segmentsReference: segments,
          discovery: {
            coverage: prepared.report.coverage,
            complete: discovery_complete,
          },
          family: prepared.family
            ? {
                family: prepared.family.family,
                status: prepared.family.status,
                coverage: prepared.family.coverage,
              }
            : null,
          limits: RASTER_EXPORT_LIMITS,
          limitations,
          resources: plans.map((p) => p.outcome),
        },
        null,
        2,
      ) + "\n",
      writer.remainingBytes,
    ),
  );
  return {
    artifact: snapshot.artifact,
    output_directory: input.output_directory,
    manifest,
    segments,
    resources: plans.length,
    exported,
    skipped: plans.length - exported,
    output_files: writer.fileCount,
    published_bytes: writer.publishedBytes,
    discovery_complete,
    resolved_controls,
    limits: RASTER_EXPORT_LIMITS,
    limitations,
  };
}
