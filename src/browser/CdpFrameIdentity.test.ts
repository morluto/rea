import { describe, expect, it } from "vitest";
import { selectCdpFrameIdentity } from "./CdpFrameIdentity.js";
import { receiveCdpEvent, type CdpEvent } from "./CdpConnection.js";
import { cdpFrameEvent } from "./protocol/CdpEvents.js";

/** Frame facts as the connection's registered event schema parses them. */
const cdpFrameEventFacts = (event: CdpEvent) => {
  const frame = cdpFrameEvent(receiveCdpEvent(event));
  if (frame === undefined)
    throw new Error(`${event.method} is not a frame event`);
  return frame.facts;
};

describe("CDP frame identity ownership", () => {
  it("keeps missing or malformed frame objects from becoming root evidence", () => {
    for (const params of [{}, { frame: null }, { frame: "frame" }]) {
      expect(
        selectCdpFrameIdentity(
          cdpFrameEventFacts({ method: "Page.frameNavigated", params }),
          "selected-main",
        ),
      ).toMatchObject({
        selection: "unknown",
        frameId: null,
        identityIssue: "missing_frame",
        parentRelation: "unknown",
        isRootReplacement: false,
      });
    }
  });

  it("recognizes a valid frame with no parent property as a root", () => {
    expect(
      selectCdpFrameIdentity(
        cdpFrameEventFacts({
          method: "Page.frameNavigated",
          params: { frame: { id: "replacement-main" } },
        }),
        "selected-main",
      ),
    ).toMatchObject({
      applicability: "applicable",
      selection: "other",
      isRootReplacement: true,
      identityIssue: null,
      parentRelation: "root",
      parentId: null,
      parentIssue: null,
    });
  });

  it("does not interpret a malformed parent value as root evidence", () => {
    expect(
      selectCdpFrameIdentity(
        cdpFrameEventFacts({
          method: "Page.frameNavigated",
          params: { frame: { id: "replacement-main", parentId: "" } },
        }),
        "selected-main",
      ),
    ).toMatchObject({
      selection: "other",
      isRootReplacement: false,
      identityIssue: null,
      parentRelation: "unknown",
      parentId: null,
      parentIssue: "invalid_parent_id",
    });
  });

  it("preserves a self-parented frame ID but leaves its parent relation unknown", () => {
    expect(
      selectCdpFrameIdentity(
        cdpFrameEventFacts({
          method: "Page.frameNavigated",
          params: {
            frame: { id: "candidate-root", parentId: "candidate-root" },
          },
        }),
        "selected-main",
      ),
    ).toMatchObject({
      selection: "other",
      isRootReplacement: false,
      frameId: "candidate-root",
      identityIssue: null,
      parentRelation: "unknown",
      parentId: null,
      parentIssue: "self_parent",
    });
  });

  it("retains the selected-main parent issue for a self-parented selected frame", () => {
    expect(
      selectCdpFrameIdentity(
        cdpFrameEventFacts({
          method: "Page.frameNavigated",
          params: { frame: { id: "selected-main", parentId: "selected-main" } },
        }),
        "selected-main",
      ),
    ).toMatchObject({
      selection: "main",
      parentRelation: "unknown",
      parentIssue: "main_frame_has_parent",
    });
  });
});
