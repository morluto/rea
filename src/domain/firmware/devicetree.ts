import { z } from "zod";
import type { AnalysisParameterLimit } from "../analysisSettings.js";
import {
  parameterBudgetLimit,
  parameterBudgetSchema,
  type ParameterBudget,
} from "../parameterBudget.js";
import { digestSchema } from "../digests.js";
import { knownCoverageStatusSchema } from "../coverage.js";
import { absoluteLocalPathStringSchema } from "../localPath.js";
const uint = z.number().int().min(0).max(0xffffffff);
export const MAX_DEVICETREE_FILE_BYTES = 16777216;
export const DEVICETREE_PROPERTY_PREVIEW_BYTES = 256;

/** The per-call budgets of `inspect_devicetree`. */
export const DEVICETREE_READ_BUDGETS = {
  max_file_bytes: {
    minimum: 40,
    maximum: MAX_DEVICETREE_FILE_BYTES,
    default_value: 4194304,
    unit: "bytes",
  },
  max_nodes: { minimum: 1, maximum: 65536, default_value: 8192, unit: "count" },
  max_properties: {
    minimum: 1,
    maximum: 262144,
    default_value: 32768,
    unit: "count",
  },
  max_depth: { minimum: 1, maximum: 256, default_value: 64, unit: "count" },
  /** Estimated bytes of the decoded report, accounted before each allocation. */
  max_decoded_bytes: {
    minimum: 1024,
    maximum: 256 * 1024 * 1024,
    default_value: 32 * 1024 * 1024,
    unit: "bytes",
  },
} as const satisfies Record<string, ParameterBudget>;
export type DevicetreeReadBudget = keyof typeof DEVICETREE_READ_BUDGETS;

export const inspectDevicetreeInputSchema = z.strictObject({
  path: absoluteLocalPathStringSchema,
  max_file_bytes: parameterBudgetSchema(DEVICETREE_READ_BUDGETS.max_file_bytes),
  max_nodes: parameterBudgetSchema(DEVICETREE_READ_BUDGETS.max_nodes),
  max_properties: parameterBudgetSchema(DEVICETREE_READ_BUDGETS.max_properties),
  max_depth: parameterBudgetSchema(DEVICETREE_READ_BUDGETS.max_depth),
  max_decoded_bytes: parameterBudgetSchema(
    DEVICETREE_READ_BUDGETS.max_decoded_bytes,
  ),
});

/** The per-call budget that stopped a devicetree inspection. */
export const devicetreeReadBudgetLimit = (
  parameter: DevicetreeReadBudget,
  effectiveValue: number,
): AnalysisParameterLimit =>
  parameterBudgetLimit(
    parameter,
    DEVICETREE_READ_BUDGETS[parameter],
    effectiveValue,
  );
export const devicetreePropertySchema = z.strictObject({
  name: z.string(),
  offset: uint,
  bytes: uint,
  hex: z
    .string()
    .regex(/^[0-9a-f]*$/)
    .max(DEVICETREE_PROPERTY_PREVIEW_BYTES * 2),
  truncated: z.boolean(),
  derived: z.strictObject({
    confidence: z.literal("derived"),
    strings: z.array(z.string()).nullable(),
    cells: z.array(uint).nullable(),
    reg: z
      .array(
        z.strictObject({
          address: z.string().nullable(),
          size: z.string().nullable(),
        }),
      )
      .nullable(),
  }),
});
export const devicetreeNodeSchema = z.strictObject({
  path: z.string(),
  parent: z.string().nullable(),
  offset: uint,
  properties: z.array(devicetreePropertySchema),
});
export const devicetreeSchema = z
  .strictObject({
    artifact: z.strictObject({
      path: z.string(),
      sha256: digestSchema,
      bytes: uint,
    }),
    header: z.strictObject({
      magic: uint,
      totalsize: uint,
      off_dt_struct: uint,
      off_dt_strings: uint,
      off_mem_rsvmap: uint,
      version: uint,
      last_comp_version: uint,
      boot_cpuid_phys: uint,
      size_dt_strings: uint,
      size_dt_struct: uint.nullable(),
    }),
    reservations: z.array(
      z.strictObject({ offset: uint, address: z.string(), size: z.string() }),
    ),
    nodes: z.array(devicetreeNodeSchema),
    references: z.array(
      z.strictObject({
        source: z.string(),
        property: z.string(),
        phandle: uint,
        target: z.string().nullable(),
        confidence: z.literal("derived"),
      }),
    ),
    summary: z.strictObject({
      confidence: z.literal("derived"),
      compatible: z.array(z.string()).nullable(),
      model: z.string().nullable(),
      bootargs: z.string().nullable(),
      stdout_path: z.string().nullable(),
      aliases: z.array(
        z.strictObject({ name: z.string(), path: z.string().nullable() }),
      ),
    }),
    coverage: z.strictObject({
      // This reader always decides coverage. An undecoded property is partial.
      status: knownCoverageStatusSchema,
      examined_nodes: uint,
      examined_properties: uint,
    }),
    limitations: z.array(z.string()),
  })
  .superRefine((report, context) => {
    const invalid = (path: (string | number)[], message: string) =>
      context.addIssue({ code: "custom", path, message });
    const { totalsize } = report.header;
    if (totalsize > report.artifact.bytes)
      return invalid(
        ["header", "totalsize"],
        "The Devicetree extent exceeds the selected artifact.",
      );
    if (report.coverage.examined_nodes !== report.nodes.length)
      return invalid(
        ["coverage", "examined_nodes"],
        "Examined node count disagrees with the listed nodes.",
      );

    const paths = new Set<string>();
    let properties = 0;
    for (const [index, node] of report.nodes.entries()) {
      if (paths.has(node.path))
        return invalid(
          ["nodes", index, "path"],
          "Duplicate Devicetree node path.",
        );
      if (node.parent !== null && !paths.has(node.parent))
        return invalid(
          ["nodes", index, "parent"],
          "The parent must precede its child in the recorded walk.",
        );
      if (node.offset >= totalsize)
        return invalid(
          ["nodes", index, "offset"],
          "The node starts outside the declared Devicetree extent.",
        );
      paths.add(node.path);
      properties += node.properties.length;
      for (const [propertyIndex, property] of node.properties.entries()) {
        if (property.offset > totalsize - property.bytes)
          return invalid(
            ["nodes", index, "properties", propertyIndex, "offset"],
            "The property range exceeds the declared Devicetree extent.",
          );
        const previewBytes = Math.min(
          property.bytes,
          DEVICETREE_PROPERTY_PREVIEW_BYTES,
        );
        if (property.hex.length !== previewBytes * 2)
          return invalid(
            ["nodes", index, "properties", propertyIndex, "hex"],
            "The property preview does not match its admitted byte count.",
          );
        if (property.truncated !== property.bytes > previewBytes)
          return invalid(
            ["nodes", index, "properties", propertyIndex, "truncated"],
            "The truncation flag disagrees with the property preview extent.",
          );
      }
    }
    if (report.coverage.examined_properties !== properties)
      return invalid(
        ["coverage", "examined_properties"],
        "Examined property count disagrees with the listed properties.",
      );
    const outside = report.reservations.findIndex(
      ({ offset }) => offset > totalsize - 16,
    );
    if (outside !== -1)
      invalid(
        ["reservations", outside, "offset"],
        "The reservation record exceeds the declared Devicetree extent.",
      );
  });
export type Devicetree = z.infer<typeof devicetreeSchema>;
export type InspectDevicetreeInput = z.infer<
  typeof inspectDevicetreeInputSchema
>;
