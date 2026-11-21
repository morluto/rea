import type { z } from "zod";
import type { inspectStructuredRasterCandidatesInputSchema } from "../../domain/native/structuredRasterCandidates.js";
import type { StructuredRasterResource } from "../../domain/structuredRasterDiscovery.js";
import type { prepareStructuredRasterAnalysis } from "./StructuredRasterAnalysis.js";
import {
  selectRasterRegistries,
  resolveRasterColorPolicy,
} from "./RasterRenderingSelection.js";
import {
  renderRasterResourceThumbnail,
  prepareRasterRenderCoverage,
  type RasterRenderLayout,
} from "./RasterResourceRendering.js";
interface PreviewOutcome {
  preview?: {
    kind: "caller-rgba" | "profile-declared";
    width: number;
    height: number;
    pngBase64: string;
    assumptions: string[];
  };
  previewUnavailable?: string;
}
function genericPreviewLayout(
  r: StructuredRasterResource,
): RasterRenderLayout | undefined {
  const h = r.status === "unique" ? r.hypotheses[0] : undefined;
  if (!h?.covered || ![1, 2, 4, 8].includes(h.bitsPerPixel)) return undefined;
  return {
    width: r.width,
    height: r.height,
    layout: `indexed${h.bitsPerPixel}` as RasterRenderLayout["layout"],
    bitsPerPixel: h.bitsPerPixel as 1 | 2 | 4 | 8,
    stride: h.stride,
    payloadRange: h.payloadRange,
    rowOrder: "top-down",
    bitOrder: "msb-first",
  };
}
/** Sequential sampled rendering, independent of export publication and full-image allocation. */
export async function createRasterPreviews(
  prepared: ReturnType<typeof prepareStructuredRasterAnalysis>,
  input: z.infer<typeof inspectStructuredRasterCandidatesInputSchema>,
  resources: StructuredRasterResource[],
  signal?: AbortSignal,
) {
  const results = new Map<number, PreviewOutcome>();
  const policy = input.color_policy;
  if (
    !policy ||
    policy.kind === "diagnostic-indices" ||
    input.max_previews === 0
  )
    return results;
  try {
    const registries = selectRasterRegistries(
      prepared.family?.registries ?? [],
      prepared.logical.logicalBase,
      input.registry_selection,
    );
    const coverage = prepareRasterRenderCoverage(
      prepared.logical.bytes.length,
      prepared.logical.coverage,
      signal,
    );
    if (coverage.status !== "prepared") {
      for (const r of resources)
        results.set(r.descriptorOffset, {
          previewUnavailable: coverage.reason,
        });
      return results;
    }
    let count = 0;
    for (const r of resources) {
      if (count >= input.max_previews) break;
      let layout: RasterRenderLayout | undefined;
      const registry = registries.length === 1 ? registries[0] : undefined;
      if (prepared.family)
        layout =
          registry?.bindingStatus === "unique"
            ? registry.bindings.find(
                (b) => b.descriptorOffset === r.descriptorOffset,
              )
            : undefined;
      else layout = genericPreviewLayout(r);
      const resolved = resolveRasterColorPolicy(policy, registry, layout);
      if (
        !layout ||
        !resolved ||
        (input.registry_selection && registries.length !== 1)
      ) {
        results.set(r.descriptorOffset, {
          previewUnavailable:
            "Color preview needs a unique admitted layout and palette; select one registry alternative when ambiguous. No colors were guessed.",
        });
        continue;
      }
      const rendered = await renderRasterResourceThumbnail(
        prepared.logical.bytes,
        layout,
        resolved,
        {
          coverage: coverage.coverage,
          maxSide: input.thumbnail_side,
          ...(signal ? { signal } : {}),
        },
      );
      if (rendered.status !== "rendered")
        results.set(r.descriptorOffset, {
          previewUnavailable: rendered.reason,
        });
      else {
        count++;
        results.set(r.descriptorOffset, {
          preview: {
            kind:
              policy.kind === "rgba-palette"
                ? "caller-rgba"
                : "profile-declared",
            width: rendered.width,
            height: rendered.height,
            pngBase64: rendered.png.toString("base64"),
            assumptions: [
              `Explicit rendering policy: ${JSON.stringify(policy)}. Layout ${layout.layout}, ${layout.rowOrder}, ${layout.bitOrder}; ${layout.provenance ?? "inferred generic layout"}.`,
              ...rendered.interpretation.assumptions,
            ],
          },
        });
      }
    }
  } catch (cause) {
    // Optional presentation must not erase the completed descriptor scan. Only
    // the exact signal reason is cancellation; unrelated rendering failures
    // retain their normal classification even if the signal is also aborted.
    if (!signal?.aborted || cause !== signal.reason) throw cause;
    for (const resource of resources)
      if (!results.has(resource.descriptorOffset))
        results.set(resource.descriptorOffset, {
          previewUnavailable:
            "Optional color preview cancelled after descriptor analysis completed.",
        });
    // Return the completed scan projection through the snapshot owner. Its
    // completion boundary publishes cancellation with this report retained as
    // partialObservation, rather than treating this as a successful operation.
  }
  return results;
}
