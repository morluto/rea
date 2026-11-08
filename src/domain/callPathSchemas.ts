import { z } from "zod";

import { emptyArraySchema } from "./emptyArraySchema.js";
import { evidenceSchema } from "./evidence.js";
import { prefixedDigestSchema } from "./../domain/digests.js";
import {
  nativeAddressSchema,
  nativeAddressInputSchema,
} from "./native/nativeAddress.js";
const evidenceIdSchema = prefixedDigestSchema("ev");

/** Strict input for explicit call-path reconstruction from complete dossiers. */
export const callPathInputSchema = z.strictObject({
  functions: z.array(evidenceSchema).min(1),
  start: z.object({ address: nativeAddressInputSchema }).strict(),
  goal: z.object({ address: nativeAddressInputSchema }).strict(),
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
  evidence_links: z.array(evidenceIdSchema).min(1),
  limitations: z.array(z.string()),
};
const searchScope = {
  graph: z.literal("supplied_evidence"),
  discovery: z.enum(["complete", "partial", "unknown"]),
  observed_status: z.enum(["found", "not_found", "unknown"]),
};

/** Evidence-cited directed call-path result containing every shortest path. */
export const callPathResultSchema = z.union([
  z.object({
    ...resultContextShape,
    status: z.literal("found"),
    shortest_hops: z.int().min(0),
    search_scope: z.object({
      ...searchScope,
      exhaustive: z.boolean(),
      observed_status: z.literal("found"),
    }),
    paths: z.array(pathSchema).min(1),
  }),
  z.object({
    ...resultContextShape,
    status: z.literal("not_found"),
    shortest_hops: z.null(),
    search_scope: z.object({
      ...searchScope,
      exhaustive: z.literal(true),
      discovery: z.literal("complete"),
      observed_status: z.literal("not_found"),
    }),
    paths: emptyArraySchema,
  }),
  z.object({
    ...resultContextShape,
    status: z.literal("unknown"),
    shortest_hops: z.null(),
    search_scope: z.union([
      z.object({
        ...searchScope,
        exhaustive: z.literal(false),
        observed_status: z.literal("unknown"),
      }),
      z.object({
        ...searchScope,
        exhaustive: z.literal(true),
        discovery: z.enum(["partial", "unknown"]),
        observed_status: z.literal("not_found"),
      }),
    ]),
    paths: emptyArraySchema,
  }),
]);

export type CallPathInput = z.infer<typeof callPathInputSchema>;
export type CallPathResult = z.infer<typeof callPathResultSchema>;
export type OutputCallPath = z.infer<typeof pathSchema>;
