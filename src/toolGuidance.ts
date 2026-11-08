import { ANALYSIS_VIEW_GUIDANCE } from "./contracts/analysisViewGuidance.js";

/** Compiled documentation shares guidance retrieval and catalog search ownership. */
export const TOOL_GUIDANCE: Readonly<
  Record<string, { readonly guide: string; readonly content: string }>
> = {
  inspect_analysis_view: {
    guide: "tools/inspect_analysis_view.md",
    content: ANALYSIS_VIEW_GUIDANCE,
  },
};
