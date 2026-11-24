import { expect, it } from "vitest";
import { snapshotDocumentNodes, snapshotNodeAt } from "./CdpSnapshotNodes.js";

const strings = [
  "#document",
  "svg",
  "xmlns",
  "http://www.w3.org/2000/svg",
  "😀",
];
const raw = () => ({
  nodeType: [9, 1, 1],
  nodeName: [0, 1, 1],
  nodeValue: [-1, -1, 4],
  parentIndex: [-1, 0, 1],
  attributes: [[], [2, 3], []],
});

it("decodes references once while retaining independently unknown facts", () => {
  const source = raw();
  source.nodeValue[1] = 999;
  const nodes = snapshotDocumentNodes(source, strings);
  if (nodes === undefined) throw new Error("Expected aligned columns");
  expect(nodes.nodeNames[1]).toBe("svg");
  expect(nodes.attributes[1]).toEqual([
    ["xmlns", "http://www.w3.org/2000/svg"],
  ]);
  expect(nodes.parents[1]).toBe(0);
  expect(nodes.nodeValues[1]).toBeUndefined();
  expect(snapshotNodeAt(nodes, 1)).toEqual({
    ok: false,
    error: { _tag: "InvalidCdpSnapshotNode", index: 1 },
  });
  expect(snapshotNodeAt(nodes, 2)).toMatchObject({
    ok: true,
    value: { nodeValue: "😀", parent: 1 },
  });
});

const readParents = (parentIndex: readonly unknown[]) =>
  snapshotDocumentNodes(
    {
      nodeType: parentIndex.map(() => 1),
      nodeName: parentIndex.map(() => 1),
      nodeValue: parentIndex.map(() => -1),
      parentIndex,
      attributes: parentIndex.map(() => []),
    },
    strings,
  )?.parents;

it("invalidates cycle facts and retains known roots, forward links, and direct descendants", () => {
  expect(readParents([1, 0, 1, -1, 6, 4, 3, -1])).toEqual([
    undefined,
    undefined,
    1,
    -1,
    6,
    4,
    3,
    -1,
  ]);
});

it("keeps malformed parents unknown without renumbering stable links", () => {
  expect(readParents([-1, 1.5, -2, 8, NaN, null, "0", 1])).toEqual([
    -1,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    1,
  ]);
});
