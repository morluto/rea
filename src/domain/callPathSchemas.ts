import { z } from "zod";

import { emptyArraySchema } from "./emptyArraySchema.js";
import { evidenceSchema } from "./evidence.js";
import { prefixedDigestSchema } from "./../domain/digests.js";
import {
  nativeAddressSchema,
  nativeAddressInputSchema,
} from "./native/nativeAddress.js";
const evidenceIdSchema = prefixedDigestSchema("ev");

/** Default number of shortest paths to return when the caller omits a capacity. */
export const DEFAULT_CALL_PATH_MAX_PATHS = 64;

/** Bound the serialized `paths` field, including its per-path citations. */
export const CALL_PATH_REPRESENTATION_BUDGET_BYTES = 2 * 1024 * 1024;

/** Strict input for explicit call-path reconstruction from complete dossiers. */
export const callPathInputSchema = z.strictObject({
  functions: z.array(evidenceSchema).min(1),
  start: z.object({ address: nativeAddressInputSchema }).strict(),
  goal: z.object({ address: nativeAddressInputSchema }).strict(),
  max_paths: z
    .number()
    .int()
    .safe()
    .positive()
    .default(DEFAULT_CALL_PATH_MAX_PATHS),
});

const citedNodeSchema = z.object({
  address: nativeAddressSchema,
  name: z.string().nullable(),
  evidence_links: z.array(evidenceIdSchema).min(1),
});
const citedEdgeSchema = z.object({
  source: nativeAddressSchema,
  target: nativeAddressSchema,
  evidence_links: z.array(evidenceIdSchema).min(1),
});
const pathSchema = z
  .object({
    hops: z.int().min(0),
    nodes: z.array(citedNodeSchema).min(1),
    edges: z.array(citedEdgeSchema),
    evidence_links: z.array(evidenceIdSchema).min(1),
  })
  .superRefine((path, context) => {
    const edgesConnectNodes = path.edges.every(
      (edge, index) =>
        edge.source === path.nodes[index]?.address &&
        edge.target === path.nodes[index + 1]?.address,
    );
    if (
      path.hops !== path.edges.length ||
      path.nodes.length !== path.edges.length + 1 ||
      !edgesConnectNodes
    )
      context.addIssue({
        code: "custom",
        message: "Path hops and edges must connect the ordered nodes",
      });
  });
const resultContextShape = {
  start: nativeAddressSchema,
  goal: nativeAddressSchema,
  explored: z.object({
    nodes: z.int().min(0),
    edges: z.int().min(0),
    depth_reached: z.int().min(0),
  }),
  total_shortest_paths: z
    .number()
    .int()
    .min(0)
    .describe(
      "Shortest start-to-goal path count. Exact unless total_shortest_paths_capped is true, where it is a lower bound.",
    ),
  total_shortest_paths_capped: z
    .boolean()
    .describe(
      "True when the exact path count exceeds the largest exactly representable integer, so total_shortest_paths only bounds it.",
    ),
  /** Whether `paths` omits shortest paths because the selected capacity was reached. */
  paths_truncated: z
    .boolean()
    .describe(
      "True when `paths` is a prefix of the shortest paths rather than the complete set.",
    ),
  paths_limited_by_bytes: z
    .boolean()
    .describe(
      "True when the serialized paths field reached its byte budget before the caller-selected path count.",
    ),
  evidence_links: z.array(evidenceIdSchema).min(1),
  limitations: z.array(z.string()),
};

/** Evidence-cited directed call-path result containing every shortest path. */
export const callPathResultSchema = z.union([
  z
    .object({
      ...resultContextShape,
      status: z.literal("found"),
      shortest_hops: z.number().int().min(0),
      search_scope: z.object({ exhaustive: z.boolean() }),
      paths: z.array(pathSchema),
    })
    .superRefine((result, context) => {
      if (result.paths_limited_by_bytes && !result.paths_truncated)
        context.addIssue({
          code: "custom",
          message: "A byte-limited shortest-path list must be marked truncated",
        });
      if (
        result.total_shortest_paths > 0 &&
        result.paths.length === 0 &&
        !result.paths_limited_by_bytes
      )
        context.addIssue({
          code: "custom",
          message:
            "A found result without inline paths must report byte-budget truncation",
        });
    }),
  z.object({
    ...resultContextShape,
    status: z.literal("not_found"),
    shortest_hops: z.null(),
    search_scope: z.object({ exhaustive: z.literal(true) }),
    paths: emptyArraySchema,
  }),
  z.object({
    ...resultContextShape,
    status: z.literal("unknown"),
    shortest_hops: z.null(),
    search_scope: z.object({ exhaustive: z.literal(false) }),
    paths: emptyArraySchema,
  }),
]);

export type CallPathInput = z.infer<typeof callPathInputSchema>;
export type CallPathResult = z.infer<typeof callPathResultSchema>;
export type OutputCallPath = z.infer<typeof pathSchema>;
