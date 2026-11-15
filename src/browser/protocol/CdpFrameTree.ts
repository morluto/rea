import { z } from "zod";

import {
  observeCdpFrameUrl,
  type CdpFrameUrlObservation,
} from "../CdpCaptureDocuments.js";
import {
  cdpStringValue,
  recordValue,
  resourceContentSize,
  type UnknownRecord,
} from "../CdpCaptureValues.js";
import {
  cdpFrameRecordFacts,
  type CdpFrameFacts,
} from "../CdpFrameIdentity.js";

/** One frame of a `Page.getFrameTree` reply, parsed once for every consumer. */
export interface CdpFrameTreeNode {
  /** The tree that listed this frame as a child; undefined only for the reply root. */
  readonly enclosing: CdpFrameTreeNode | undefined;
  readonly facts: CdpFrameFacts;
  readonly url: CdpFrameUrlObservation;
  readonly securityOrigin: string | undefined;
  readonly children: readonly CdpFrameTreeNode[];
}

/**
 * A parsed frame tree. Malformed frame fields stay in each node's facts; an
 * unreadable `childFrames` list or entry hides an unknown number of frames.
 */
export interface CdpFrameTree {
  readonly root: CdpFrameTreeNode;
  /** Every readable frame in document preorder, root first. */
  readonly frames: readonly CdpFrameTreeNode[];
  readonly omittedFrames: boolean;
}

/** One `Page.getResourceTree` resource entry. */
export interface CdpFrameResource {
  readonly url: string | undefined;
  readonly type: string | undefined;
  readonly mimeType: string | undefined;
  readonly contentSize: ReturnType<typeof resourceContentSize>;
}

/**
 * Resources from every readable frame of a `Page.getResourceTree` reply. A
 * missing resource list or unreadable child frame hides an unknown number of
 * resources; a non-object entry hides exactly one.
 */
export interface CdpResourceTree {
  readonly resources: readonly CdpFrameResource[];
  readonly omittedResources: boolean;
  readonly malformedResources: number;
}

interface MutableNode extends CdpFrameTreeNode {
  readonly children: CdpFrameTreeNode[];
}

const isRecord = (value: unknown): value is UnknownRecord =>
  recordValue(value) !== undefined;

const treeRecord = z.custom<UnknownRecord>(isRecord, {
  message: "Expected a frame tree object.",
});

const readChildren = (
  tree: UnknownRecord,
): {
  readonly children: readonly UnknownRecord[];
  readonly omitted: boolean;
} => {
  const raw = tree.childFrames;
  if (raw === undefined) return { children: [], omitted: false };
  if (!Array.isArray(raw)) return { children: [], omitted: true };
  const children = raw.filter(isRecord);
  return { children, omitted: children.length !== raw.length };
};

/** Walk iteratively so a deep producer tree cannot exhaust the call stack. */
const walkTrees = (
  root: UnknownRecord,
  visit: (tree: UnknownRecord, node: MutableNode) => void,
): CdpFrameTree => {
  let omittedFrames = false;
  const frames: CdpFrameTreeNode[] = [];
  const pending: { tree: UnknownRecord; enclosing: MutableNode | undefined }[] =
    [{ tree: root, enclosing: undefined }];
  let rootNode: CdpFrameTreeNode | undefined;
  while (pending.length > 0) {
    const { tree, enclosing } = pending.pop()!;
    const frame = recordValue(tree.frame);
    const node: MutableNode = {
      enclosing,
      facts: cdpFrameRecordFacts(frame),
      url: observeCdpFrameUrl(frame),
      securityOrigin: cdpStringValue(frame?.securityOrigin),
      children: [],
    };
    rootNode ??= node;
    enclosing?.children.push(node);
    frames.push(node);
    visit(tree, node);
    const { children, omitted } = readChildren(tree);
    omittedFrames ||= omitted;
    for (let index = children.length - 1; index >= 0; index -= 1)
      pending.push({ tree: children[index]!, enclosing: node });
  }
  return { root: rootNode!, frames, omittedFrames };
};

/** `Page.getFrameTree`: only a missing or non-object tree rejects the reply. */
export const cdpFrameTreeReplySchema = z
  .object({ frameTree: treeRecord })
  .transform(({ frameTree }) => walkTrees(frameTree, () => undefined));

/** `Page.getResourceTree`: resource facts from every readable frame. */
export const cdpResourceTreeReplySchema = z
  .object({ frameTree: treeRecord })
  .transform(({ frameTree }): CdpResourceTree => {
    const resources: CdpFrameResource[] = [];
    let omittedResources = false;
    let malformedResources = 0;
    const tree = walkTrees(frameTree, (raw) => {
      if (!Array.isArray(raw.resources)) {
        omittedResources = true;
        return;
      }
      for (const entry of raw.resources) {
        const resource = recordValue(entry);
        if (resource === undefined) {
          malformedResources += 1;
          continue;
        }
        resources.push({
          url: cdpStringValue(resource.url),
          type: cdpStringValue(resource.type),
          mimeType: cdpStringValue(resource.mimeType),
          contentSize: resourceContentSize(resource.contentSize),
        });
      }
    });
    return {
      resources,
      omittedResources: omittedResources || tree.omittedFrames,
      malformedResources,
    };
  });

/** The readable URL of an observed frame; malformed or missing identity is undefined. */
export const observedFrameUrl = (
  observation: CdpFrameUrlObservation,
): string | undefined =>
  observation.kind === "observed" ? observation.url : undefined;
