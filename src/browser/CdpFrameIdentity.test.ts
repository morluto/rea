import { expect, it } from "vitest";
import { selectCdpFrameIdentity } from "./CdpFrameIdentity.js";
import { receiveCdpEvent } from "./CdpConnection.js";
import { cdpFrameEvent } from "./protocol/CdpEvents.js";

const selectFrame = (frame: unknown, selected = "selected-main") => {
  const event = cdpFrameEvent(
    receiveCdpEvent({ method: "Page.frameNavigated", params: { frame } }),
  );
  if (event === undefined) throw new Error("Expected a frame navigation");
  return selectCdpFrameIdentity(event.facts, selected);
};

it("keeps missing or malformed frame objects from becoming root evidence", () => {
  for (const frame of [undefined, null, "frame"]) {
    expect(selectFrame(frame)).toMatchObject({
      selection: "unknown",
      frameId: null,
      identityIssue: "missing_frame",
      parentRelation: "unknown",
      isRootReplacement: false,
    });
  }
});

it("distinguishes a replacement root from a frame with contradictory parent facts", () => {
  expect(selectFrame({ id: "candidate" })).toMatchObject({
    applicability: "applicable",
    selection: "other",
    isRootReplacement: true,
    identityIssue: null,
    parentRelation: "root",
    parentId: null,
    parentIssue: null,
  });

  for (const [parentId, parentIssue] of [
    ["", "invalid_parent_id"],
    ["candidate", "self_parent"],
  ]) {
    expect(selectFrame({ id: "candidate", parentId })).toMatchObject({
      selection: "other",
      isRootReplacement: false,
      frameId: "candidate",
      identityIssue: null,
      parentRelation: "unknown",
      parentId: null,
      parentIssue,
    });
  }

  expect(
    selectFrame({ id: "candidate", parentId: "candidate" }, "candidate"),
  ).toMatchObject({
    selection: "main",
    parentRelation: "unknown",
    parentIssue: "main_frame_has_parent",
  });
});
