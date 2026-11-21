import { expect, it } from "vitest";

import { TOOL_CONTRACTS } from "../../../src/contracts/toolContracts.js";

it("marks every tool except the audited content-free exceptions", () => {
  const contentFree = TOOL_CONTRACTS.filter(
    ({ returnsTargetContent }) => returnsTargetContent !== true,
  )
    .map(({ name }) => name)
    .sort();
  expect(contentFree).toEqual([
    "export_evidence_bundle",
    "guided_workflows",
    "inspect_analysis_settings",
    "read_guidance_section",
    "record_unknown",
    "search_guidance",
    "update_analysis_settings",
  ]);
});
