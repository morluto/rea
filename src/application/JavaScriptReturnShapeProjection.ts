import { jsonObjectSchema, jsonValueSchema } from "../domain/jsonValue.js";
import type {
  JavaScriptSemanticIr,
  JavaScriptSemanticCallable,
  JavaScriptSemanticModuleLink,
} from "../domain/javascriptSemanticIr.js";
import { flattenSemanticReturnValue } from "../domain/javascriptSemanticReturns.js";
import type { JavaScriptSourceRange } from "../domain/javascriptStaticAnalysisTypes.js";
import type { JavaScriptArtifactGraphCoverage } from "./JavaScriptArtifactGraphContext.js";
import { partialReconstructionCoverage } from "./JavaScriptArtifactGraphEvidence.js";

const MAX_PROJECTED_RETURN_SHAPES = 32;
const MAX_PROJECTED_RETURN_FIELDS = 64;
const MAX_PROJECTED_PROPERTY_COVERAGE = 64;

export interface JavaScriptReturnShapeProjection {
  readonly properties: ReturnType<typeof jsonObjectSchema.parse>;
  readonly range: JavaScriptSourceRange;
  readonly coverage: JavaScriptArtifactGraphCoverage;
  readonly limitations: readonly string[];
}

/** Project one exact export/callable link into shallow bounded graph values. */
export const projectJavaScriptExportReturnShapes = (input: {
  readonly ir: JavaScriptSemanticIr;
  readonly link: JavaScriptSemanticModuleLink;
  readonly modulePath: string;
  readonly baseCoverage: JavaScriptArtifactGraphCoverage;
}): JavaScriptReturnShapeProjection | null => {
  if (input.link.callableId === null || input.link.exportedName === null)
    return null;
  const callable = input.ir.callables.find(
    ({ callableId }) => callableId === input.link.callableId,
  );
  if (callable === undefined) return null;
  const projection = projectReturnSites(callable);
  const projectionOmitted =
    projection.omittedSites +
    projection.omittedFields +
    projection.omittedCoverage;
  const semanticOmitted = callable.returnCoverage.omittedCount;
  const complete =
    input.baseCoverage.status === "complete" &&
    callable.returnCoverage.status === "complete" &&
    projectionOmitted === 0;
  const coverage = complete
    ? input.baseCoverage
    : partialReconstructionCoverage(
        [
          ...input.baseCoverage.limits,
          {
            name: "return-shape-sites",
            value: MAX_PROJECTED_RETURN_SHAPES,
            unit: "items",
          },
          {
            name: "return-shape-fields",
            value: MAX_PROJECTED_RETURN_FIELDS,
            unit: "items",
          },
          {
            name: "return-shape-property-coverage",
            value: MAX_PROJECTED_PROPERTY_COVERAGE,
            unit: "items",
          },
        ],
        semanticOmitted === null ? null : semanticOmitted + projectionOmitted,
        callable.returnCoverage.status === "truncated" || projectionOmitted > 0,
      );
  const limitations = [
    ...input.ir.limitations,
    "Return shapes are inferred from inert syntax and do not prove runtime behavior.",
    ...(callable.returnSites.length === 0
      ? [
          "No direct return value was retained; runtime return behavior remains unknown.",
        ]
      : []),
    ...(projectionOmitted > 0
      ? ["Return-shape graph projection reached explicit retention limits."]
      : []),
  ];
  return {
    properties: jsonObjectSchema.parse({
      semantic_role: "export-return-shapes",
      module_path: input.modulePath,
      exported_name: input.link.exportedName,
      callable_id: callable.callableId,
      callable_kind: callable.kind,
      static_return_shapes: projection.shapes,
      return_shape_coverage: {
        status: callable.returnCoverage.status,
        retained_return_sites: projection.shapes.length,
        omitted_return_sites:
          semanticOmitted === null
            ? null
            : semanticOmitted + projection.omittedSites,
        omitted_fields: projection.omittedFields,
        omitted_property_coverage: projection.omittedCoverage,
        projection_complete: projectionOmitted === 0,
      },
    }),
    range: callable.location,
    coverage,
    limitations,
  };
};

const projectReturnSites = (callable: JavaScriptSemanticCallable) => {
  let retainedFields = 0;
  let retainedCoverage = 0;
  let omittedFields = 0;
  let omittedCoverage = 0;
  const retainedSites = callable.returnSites.slice(
    0,
    MAX_PROJECTED_RETURN_SHAPES,
  );
  const shapes = retainedSites.map((site) => {
    const flattened = flattenSemanticReturnValue(site.value);
    const remainingFields = Math.max(
      0,
      MAX_PROJECTED_RETURN_FIELDS - retainedFields,
    );
    const fields = flattened.fields.slice(0, remainingFields).map((field) => ({
      ...field,
      value: jsonValueSchema.parse(field.value),
    }));
    retainedFields += fields.length;
    omittedFields += flattened.fields.length - fields.length;
    const remainingCoverage = Math.max(
      0,
      MAX_PROJECTED_PROPERTY_COVERAGE - retainedCoverage,
    );
    const propertyCoverage = flattened.propertyCoverage.slice(
      0,
      remainingCoverage,
    );
    retainedCoverage += propertyCoverage.length;
    omittedCoverage +=
      flattened.propertyCoverage.length - propertyCoverage.length;
    return {
      source_range: site.location,
      value_status: site.value.status,
      fields,
      property_coverage: propertyCoverage,
    };
  });
  return {
    shapes,
    omittedSites: callable.returnSites.length - retainedSites.length,
    omittedFields,
    omittedCoverage,
  };
};
