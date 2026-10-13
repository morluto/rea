import { z } from "zod";
import { pcapResultSchemas } from "../pcap/pcapAnalysis.js";
import { analysisInputErrorFromIssues } from "../inputIssueProjection.js";
import type { AnalysisError } from "../analysisErrorBase.js";
import { err, ok, type Result } from "../result.js";
import {
  analysisViewInputError,
  type AnalysisViewParent,
  type AnalysisViewRequest,
  type UnsignedAnalysisView,
} from "./analysisView.js";
import {
  completeWithinViewCoverage,
  pageViewCoverage,
} from "./analysisViewCoverage.js";

const captureSchema = pcapResultSchemas.inspect_pcap_capture;
const fields = captureSchema.shape;
const pageShape = {
  kind: z.literal("pcap"),
  offset: z.number().int().nonnegative().default(0),
  limit: z.number().int().positive().default(64),
};
export const pcapViewRequestSchema = z.discriminatedUnion("facet", [
  z.strictObject({
    ...pageShape,
    facet: z.enum([
      "endpoints",
      "dns-queries",
      "tls-sni",
      "protocols",
      "http-uris",
      "unattributed-addresses",
    ]),
  }),
  z.strictObject({
    ...pageShape,
    facet: z.literal("dns-addresses"),
    query: z.string().min(1),
  }),
  z.strictObject({
    ...pageShape,
    facet: z.literal("diagnostics"),
    stream: z.enum(["tshark", "capinfos"]),
  }),
]);
export const pcapViewPageSchema = z.discriminatedUnion("facet", [
  z.strictObject({ facet: z.literal("endpoints"), items: fields.endpoints }),
  z.strictObject({
    facet: z.literal("dns-queries"),
    items: z.array(
      fields.dns_queries.element.omit({ response_addresses: true }).extend({
        retained_response_address_count: z.number().int().nonnegative(),
      }),
    ),
  }),
  z.strictObject({ facet: z.literal("tls-sni"), items: fields.tls_sni_values }),
  z.strictObject({
    facet: z.literal("protocols"),
    items: fields.protocol_distribution,
  }),
  z.strictObject({
    facet: z.literal("http-uris"),
    items: fields.http_request_uris,
  }),
  z.strictObject({
    facet: z.literal("unattributed-addresses"),
    items: fields.unattributed_dns_addresses,
  }),
  z.strictObject({
    facet: z.literal("dns-addresses"),
    items: fields.unattributed_dns_addresses,
  }),
  z.strictObject({
    facet: z.literal("diagnostics"),
    text: z.string(),
    status: z.enum(["retained", "unknown"]),
  }),
]);
export const pcapSummarySchema = captureSchema
  .omit({
    endpoints: true,
    dns_queries: true,
    tls_sni_values: true,
    protocol_distribution: true,
    http_request_uris: true,
    unattributed_dns_addresses: true,
    diagnostics: true,
  })
  .extend({
    retained_counts: z.strictObject({
      endpoints: z.number().int().nonnegative(),
      dns_queries: z.number().int().nonnegative(),
      tls_sni_values: z.number().int().nonnegative(),
      protocol_distribution: z.number().int().nonnegative(),
      http_request_uris: z.number().int().nonnegative(),
      unattributed_dns_addresses: z.number().int().nonnegative(),
    }),
    diagnostics_code_units: z
      .strictObject({
        tshark: z.number().int().nonnegative(),
        capinfos: z.number().int().nonnegative(),
      })
      .nullable(),
  });
type Capture = z.output<typeof captureSchema>;
type PcapView = z.output<typeof pcapViewRequestSchema>;
type Page = z.output<typeof pcapViewPageSchema>;

const parseParent = (
  parent: AnalysisViewParent,
): Result<Capture, AnalysisError> => {
  const parsed = captureSchema.safeParse(parent.normalizedResult);
  if (!parsed.success)
    return err(
      analysisInputErrorFromIssues(
        "inspect_analysis_view",
        parsed.error.issues,
        parent.normalizedResult,
        { cause: parsed.error },
      ),
    );
  if (
    parent.subject?.local_path !== parsed.data.target.path ||
    parent.subject.digest.sha256 !== parsed.data.target.sha256
  )
    return err(
      analysisViewInputError([
        {
          path: ["source", "subject"],
          reason: "invalid_value",
          message:
            "Packet parent subject must identify the report's exact path and SHA-256.",
        },
      ]),
    );
  return ok(parsed.data);
};
const summarize = ({
  endpoints,
  dns_queries,
  tls_sni_values,
  protocol_distribution,
  http_request_uris,
  unattributed_dns_addresses,
  diagnostics,
  ...metadata
}: Capture) => ({
  ...metadata,
  retained_counts: {
    endpoints: endpoints.length,
    dns_queries: dns_queries.length,
    tls_sni_values: tls_sni_values.length,
    protocol_distribution: protocol_distribution.length,
    http_request_uris: http_request_uris.length,
    unattributed_dns_addresses: unattributed_dns_addresses.length,
  },
  diagnostics_code_units:
    diagnostics === undefined
      ? null
      : {
          tshark: diagnostics.tshark_stderr.length,
          capinfos: diagnostics.capinfos_stderr.length,
        },
});

const selectRows = (
  capture: Capture,
  view: Exclude<PcapView, { facet: "diagnostics" }>,
): Result<
  { page: Exclude<Page, { facet: "diagnostics" }>; total: number },
  AnalysisError
> => {
  const slice = <T>(items: readonly T[]) =>
    items.slice(view.offset, view.offset + view.limit);
  switch (view.facet) {
    case "endpoints":
      return ok({
        page: { facet: view.facet, items: slice(capture.endpoints) },
        total: capture.endpoints.length,
      });
    case "dns-queries":
      return ok({
        page: {
          facet: view.facet,
          items: slice(capture.dns_queries).map(
            ({ response_addresses, ...query }) => ({
              ...query,
              retained_response_address_count: response_addresses.length,
            }),
          ),
        },
        total: capture.dns_queries.length,
      });
    case "tls-sni":
      return ok({
        page: { facet: view.facet, items: slice(capture.tls_sni_values) },
        total: capture.tls_sni_values.length,
      });
    case "protocols":
      return ok({
        page: {
          facet: view.facet,
          items: slice(capture.protocol_distribution),
        },
        total: capture.protocol_distribution.length,
      });
    case "http-uris":
      return ok({
        page: { facet: view.facet, items: slice(capture.http_request_uris) },
        total: capture.http_request_uris.length,
      });
    case "unattributed-addresses":
      return ok({
        page: {
          facet: view.facet,
          items: slice(capture.unattributed_dns_addresses),
        },
        total: capture.unattributed_dns_addresses.length,
      });
    case "dns-addresses": {
      const matches = capture.dns_queries.filter(
        (query) => query.query === view.query,
      );
      if (matches.length !== 1)
        return err(
          analysisViewInputError([
            {
              path: ["view", "query"],
              reason: "invalid_value",
              message: "Select one unambiguous exact retained DNS question.",
            },
          ]),
        );
      return ok({
        page: {
          facet: view.facet,
          items: slice(matches[0]!.response_addresses),
        },
        total: matches[0]!.response_addresses.length,
      });
    }
  }
};

/** Historical packet facts are paged without reopening the source or rerunning Wireshark. */
export const projectPcapCaptureView = (
  parent: AnalysisViewParent,
  view: AnalysisViewRequest,
): Result<UnsignedAnalysisView, AnalysisError> => {
  if (view.kind !== "summary" && view.kind !== "pcap")
    return err(
      analysisViewInputError([
        {
          path: ["view"],
          reason: "invalid_value",
          message:
            "Packet summary parents support summary and pcap fact pages.",
        },
      ]),
    );
  const parsed = parseParent(parent);
  if (!parsed.ok) return parsed;
  const capture = parsed.value;
  const shared = {
    parent_evidence_id: parent.evidenceId,
    parent_operation: "inspect_pcap_capture" as const,
    parent_digest: parent.evidenceId.slice(3),
    artifact: { path: capture.target.path, sha256: capture.target.sha256 },
    limitations: [
      ...parent.limitations,
      "Page totals count retained rows or UTF-16 diagnostic code units. Exhaustion does not prove whole-network completeness; source coverage and examined counts remain separate.",
    ],
    unknowns: [
      "Saved packet observations do not establish process identity, causality, encrypted payload contents or traffic missing from the recording.",
    ],
  };
  if (view.kind === "summary")
    return ok({
      kind: "summary",
      view,
      ...shared,
      summary: summarize(capture),
      coverage: completeWithinViewCoverage(1, 1),
    });
  if (view.facet === "diagnostics") {
    const value =
      view.stream === "tshark"
        ? capture.diagnostics?.tshark_stderr
        : capture.diagnostics?.capinfos_stderr;
    const text = value?.slice(view.offset, view.offset + view.limit) ?? "";
    return ok({
      kind: "pcap",
      view,
      ...shared,
      source_coverage: capture.coverage,
      page: {
        facet: "diagnostics",
        text,
        status: value === undefined ? "unknown" : "retained",
      },
      coverage: pageViewCoverage(view.offset, text.length, value?.length ?? 0),
      unknowns:
        value === undefined
          ? [
              ...shared.unknowns,
              "The parent did not retain diagnostics; an empty text page does not establish their absence.",
            ]
          : shared.unknowns,
    });
  }
  const selected = selectRows(capture, view);
  return selected.ok
    ? ok({
        kind: "pcap",
        view,
        ...shared,
        source_coverage: capture.coverage,
        page: selected.value.page,
        coverage: pageViewCoverage(
          view.offset,
          selected.value.page.items.length,
          selected.value.total,
        ),
      })
    : selected;
};
