import { expect, it } from "vitest";
import { decodeSazMetadata } from "./SazMetadata.js";

it("reports a declared legacy XML encoding as unsupported", () => {
  expect(() =>
    decodeSazMetadata(
      Buffer.from('<?xml version="1.0" encoding="ISO-8859-1"?><Session/>'),
    ),
  ).toThrow(
    expect.objectContaining({
      failure: expect.objectContaining({
        kind: "unsupported",
        format: "web-network-capture",
      }),
      message: expect.stringContaining("ISO-8859-1"),
    }),
  );
});

it("preserves XML node order, attributes, entities, and literal replacement characters", () => {
  const decoded = decodeSazMetadata(
    Buffer.from(
      '<?xml version="1.0"?><Session><!-- note & literal --><Value title="caf�">A &amp; B�</Value><C><![CDATA[C & D]]></C></Session>',
    ),
  );
  expect(decoded).toMatchObject({
    name: "#document",
    children: [
      { name: "xml" },
      {
        name: "Session",
        children: [
          { name: "#comment", value: " note & literal " },
          {
            name: "Value",
            attributes: [{ name: "title", value: "caf�" }],
            children: [{ name: "#text", value: "A & B�" }],
          },
          { name: "C", children: [{ name: "#cdata-section", value: "C & D" }] },
        ],
      },
    ],
  });
});

it("refuses malformed markup even when the XML contains a literal replacement character", () => {
  expect(() => decodeSazMetadata(Buffer.from('<Session a="x"b="�"/>'))).toThrow(
    expect.objectContaining({
      failure: expect.objectContaining({
        kind: "malformed",
        format: "web-network-capture",
      }),
    }),
  );
});
