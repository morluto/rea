import { z } from "incur";
import {
  javaScriptRoutesDeliverySchema,
  webRoutesDeliverySchema,
} from "../domain/analysisView/javascriptRoutesView.js";
import {
  analysisEvidenceDeliveryOptions,
  parseCliAnalysisEvidenceDelivery,
} from "./analysisEvidenceDelivery.js";

export const javascriptRouteDeliveryOptions = {
  ...analysisEvidenceDeliveryOptions,
  view: z
    .string()
    .optional()
    .describe(
      "JSON javascript-routes view; requires --detail summary and --evidence_output",
    ),
};

export const webBundleDeliveryOptions = {
  ...javascriptRouteDeliveryOptions,
  view: javascriptRouteDeliveryOptions.view.describe(
    "JSON web-bundle (endpoints, inferences, summary) or javascript-routes view; requires --detail summary and --evidence_output",
  ),
};

/** Validate delivery before opening artifacts or attaching a browser. */
export const parseJavaScriptRouteDelivery = (
  operation: string,
  options: {
    detail: "complete" | "summary";
    evidence_output?: string | undefined;
    view?: string | undefined;
  },
) => {
  const schema =
    operation === "analyze_web_bundle"
      ? webRoutesDeliverySchema
      : javaScriptRoutesDeliverySchema;
  return parseCliAnalysisEvidenceDelivery(operation, options, schema);
};
