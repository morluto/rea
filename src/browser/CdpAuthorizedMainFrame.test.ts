import { describe, expect, it } from "vitest";

import { reconcileMainFrame } from "./CdpAuthorizedMainFrame.js";

const frameTree = (loaderId: string) => ({
  frameTree: {
    frame: { id: "main", loaderId, url: ":" },
  },
});

describe("CDP masked main-frame reconciliation", () => {
  it("discards target information when the document changes during recovery", async () => {
    const changed = frameTree("loader-b");
    const snapshot = await reconcileMainFrame({
      frameTree: frameTree("loader-a"),
      targetId: "target-1",
      operation: "inspect_web_page",
      getTargetInfo: async () => ({
        targetInfo: {
          targetId: "target-1",
          url: "https://app.example.test/document-a",
        },
      }),
      getFrameTree: async () => changed,
    });

    expect(snapshot).toEqual({
      frameTree: changed,
      reportedUrl: ":",
      url: undefined,
      urlSource: "frame_tree",
    });
  });

  it("discards target information when a same-document URL changes during recovery", async () => {
    const stableTree = frameTree("loader-a");
    let targetInfoReads = 0;
    const snapshot = await reconcileMainFrame({
      frameTree: stableTree,
      targetId: "target-1",
      operation: "inspect_web_page",
      getTargetInfo: async () => {
        targetInfoReads += 1;
        return {
          targetInfo: {
            targetId: "target-1",
            url: `https://app.example.test/document#${String(targetInfoReads)}`,
          },
        };
      },
      getFrameTree: async () => stableTree,
    });

    expect(snapshot).toEqual({
      frameTree: stableTree,
      reportedUrl: ":",
      url: undefined,
      urlSource: "frame_tree",
    });
  });
});
