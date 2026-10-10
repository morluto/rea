import { describe, expect, it } from "vitest";

import { inspectWebPageInputSchema } from "../domain/browserObservation.js";
import { captureDom } from "./CdpCaptureDocuments.js";

const origin = "https://app.example.test";
const documentUrl = `${origin}/screens/app`;
const input = inspectWebPageInputSchema.parse({
  cdp_endpoint: "http://127.0.0.1:9222",
  allowed_origins: [origin],
  target_id: "page-1",
});

const snapshot = (
  baseUrl?: string,
  baseHref = "assets/",
  pageUrl = documentUrl,
  linkHref = "guide",
) => ({
  strings: [
    pageUrl,
    baseUrl ?? "",
    "#document",
    "BASE",
    "A",
    "LINK",
    "FORM",
    "",
    "href",
    baseHref,
    linkHref,
    "rel",
    "mcp",
    "agent",
    "action",
    "submit",
  ],
  documents: [
    {
      documentURL: 0,
      ...(baseUrl === undefined ? {} : { baseURL: 1 }),
      nodes: {
        nodeType: [9, 1, 1, 1, 1],
        nodeName: [2, 3, 4, 5, 6],
        nodeValue: [7, 7, 7, 7, 7],
        parentIndex: [-1, 0, 0, 0, 0],
        attributes: [[], [8, 9], [8, 10], [8, 13, 11, 12], [14, 15]],
      },
    },
  ],
});

const capture = (value: ReturnType<typeof snapshot>) =>
  captureDom(value, new Set([origin]), input);

describe("DOM metadata document base URLs", () => {
  it("resolves links, actions and agent hints against the captured document base", () => {
    const result = capture(snapshot(`${origin}/screens/assets/`));
    expect(result.urls.map(({ url }) => url)).toEqual([
      `${origin}/screens/assets/`,
      `${origin}/screens/assets/guide`,
      `${origin}/screens/assets/agent`,
      `${origin}/screens/assets/submit`,
    ]);
    expect(result.agentHints[0]?.url).toBe(`${origin}/screens/assets/agent`);
  });

  it("uses the document URL as fallback when no baseURL was supplied", () => {
    const result = capture(snapshot());
    expect(result.urls.map(({ url }) => url)).toEqual([
      `${origin}/screens/assets/`,
      `${origin}/screens/guide`,
      `${origin}/screens/agent`,
      `${origin}/screens/submit`,
    ]);
  });

  it("applies destination policy after resolving an ordinary foreign base", () => {
    const foreign = "https://cdn.example.test/assets/";
    const result = capture(snapshot(foreign, foreign));
    expect(result.nodes).toHaveLength(5);
    expect(result.urls).toHaveLength(4);
    expect(
      result.urls.every(
        ({ url, destination_scope }) =>
          url === null && destination_scope === "outside_policy",
      ),
    ).toBe(true);
    expect(result.agentHints[0]?.url).toBeNull();
  });

  it("keeps an absolute approved link independent of a foreign base", () => {
    const foreign = "https://cdn.example.test/assets/";
    const result = capture(
      snapshot(foreign, foreign, documentUrl, `${origin}/guide`),
    );
    expect(result.urls[1]).toMatchObject({
      url: `${origin}/guide`,
      destination_scope: "approved",
    });
  });

  it.each([
    "javascript:void(0)",
    "mailto:someone@example.test",
    "data:text/plain,hello",
    "ftp://app.example.test/file",
  ])("classifies the non-http(s) destination %s as unsupported", (href) => {
    const result = capture(snapshot(undefined, "assets/", documentUrl, href));
    expect(result.urls[1]).toMatchObject({
      url: null,
      destination_scope: "unsupported",
    });
  });

  it("classifies an unparseable destination as unsupported", () => {
    const result = capture(
      snapshot(undefined, "assets/", documentUrl, "https://[invalid"),
    );
    expect(result.urls[1]).toMatchObject({
      url: null,
      destination_scope: "unsupported",
    });
  });

  it("classifies a same-origin destination with credentials as approved", () => {
    const result = capture(
      snapshot(
        undefined,
        "assets/",
        documentUrl,
        "https://user:secret@app.example.test/guide",
      ),
    );
    expect(result.urls[1]).toMatchObject({
      url: `${origin}/guide`,
      destination_scope: "approved",
    });
  });

  it("does not authorize a foreign document using its approved base URL", () => {
    const result = capture(
      snapshot(
        `${origin}/assets/`,
        "assets/",
        "https://outside.example.test/app",
      ),
    );
    expect(result.nodes).toEqual([]);
    expect(result.urls).toEqual([]);
    expect(result.agentHints).toEqual([]);
  });
});

describe("empty form destinations with a document base URL", () => {
  it("keeps an empty form action approved when the document base is foreign", () => {
    const foreign = "https://cdn.example.test/assets/";
    const value = snapshot(foreign, foreign);
    value.strings[15] = "";
    expect(capture(value).urls[3]).toMatchObject({
      url: documentUrl,
      destination_scope: "approved",
    });
  });

  it.each([" ", "\t\r\n\f"])(
    "resolves an HTML-whitespace-only form action to the document: %j",
    (action) => {
      const baseUrl = `${origin}/assets/`;
      const value = snapshot(baseUrl);
      value.strings[15] = action;
      expect(capture(value).urls[3]?.url).toBe(documentUrl);
    },
  );

  it.each(["BUTTON", "INPUT"])(
    "retains document-base resolution for a whitespace-only %s formaction",
    (nodeName) => {
      const baseUrl = `${origin}/assets/`;
      const value = snapshot(baseUrl);
      value.strings[6] = nodeName;
      value.strings[14] = "formaction";
      value.strings[15] = " ";
      expect(capture(value).urls[3]?.url).toBe(baseUrl);
    },
  );

  it.each([
    { value: "\u000b", suffix: "" },
    { value: "\u00a0", suffix: "%C2%A0" },
  ])(
    "does not treat non-HTML whitespace as an empty form action: $value",
    ({ value: action, suffix }) => {
      const baseUrl = `${origin}/assets/`;
      const value = snapshot(baseUrl);
      value.strings[15] = action;
      expect(capture(value).urls[3]?.url).toBe(`${baseUrl}${suffix}`);
    },
  );

  it("keeps the first value when an attribute name repeats", () => {
    const value = snapshot();
    const later = `${origin}/later`;
    value.strings.push(later);
    const href = value.strings.indexOf("href");
    const guide = value.strings.indexOf("guide");
    const nodes = value.documents[0]?.nodes;
    if (nodes === undefined) throw new TypeError("Expected a DOM snapshot");
    nodes.attributes[2] = [href, guide, href, value.strings.length - 1];
    const result = capture(value);
    expect(result.nodes[2]?.attribute_names).toEqual(["href"]);
    expect(result.urls.map(({ url }) => url)).toContain(
      `${origin}/screens/guide`,
    );
    expect(result.urls.map(({ url }) => url)).not.toContain(later);
  });

  it("does not apply form semantics to an action attribute on another element", () => {
    const baseUrl = `${origin}/assets/`;
    const value = snapshot(baseUrl);
    value.strings[6] = "DIV";
    value.strings[15] = "";
    expect(capture(value).urls[3]?.url).toBe(baseUrl);
  });
});

describe("repeated DOM attribute names", () => {
  it("keeps the first declaration for attribute names and destination URLs", () => {
    const value = snapshot(undefined, "assets/", documentUrl, "guide");
    const hrefUpperIndex = value.strings.length;
    const secondGuideIndex = hrefUpperIndex + 1;
    value.strings.push("href", "second-guide");
    const docNodes = value.documents[0]?.nodes;
    if (docNodes !== undefined) {
      docNodes.attributes[2] = [8, 10, hrefUpperIndex, secondGuideIndex];
    }
    const result = capture(value);
    const linkNode = result.nodes[2];
    expect(linkNode?.attribute_names).toEqual(["href"]);
    const linkUrl = result.urls.find(({ node_index }) => node_index === 2);
    expect(linkUrl?.url).toBe(`${origin}/screens/guide`);
  });
});

it("preserves case-sensitive SVG attributes and uses the actual href", () => {
  const value = snapshot();
  const first = value.strings.length;
  value.strings.push(
    "a",
    "HREF",
    "/wrong",
    "href",
    "/actual",
    "viewBox",
    "viewbox",
    "0 0 10 10",
  );
  value.documents[0]!.nodes.nodeName[2] = first;
  value.documents[0]!.nodes.attributes[2] = [
    first + 1,
    first + 2,
    first + 3,
    first + 4,
    first + 5,
    first + 7,
    first + 6,
    first + 7,
  ];
  const result = capture(value);
  expect(result.nodes[2]?.attribute_names).toEqual([
    "HREF",
    "href",
    "viewBox",
    "viewbox",
  ]);
  expect(result.urls.find(({ node_index }) => node_index === 2)?.url).toBe(
    `${origin}/actual`,
  );
});

interface SvgSnapshotNode {
  readonly name: string;
  readonly parent: number;
  readonly attributes?: readonly (readonly [string, string])[];
}

const svgDocument = (
  elements: readonly SvgSnapshotNode[],
  baseUrl = `${origin}/screens/assets/`,
) => {
  const strings = [documentUrl, baseUrl];
  const intern = (value: string): number => {
    const existing = strings.indexOf(value);
    if (existing >= 0) return existing;
    strings.push(value);
    return strings.length - 1;
  };
  const nodeType = [9];
  const nodeName = [intern("#document")];
  const nodeValue = [intern("")];
  const parentIndex = [-1];
  const attributes: number[][] = [[]];
  for (const element of elements) {
    nodeType.push(1);
    nodeName.push(intern(element.name));
    nodeValue.push(intern(""));
    parentIndex.push(element.parent);
    const encoded: number[] = [];
    for (const [name, value] of element.attributes ?? [])
      encoded.push(intern(name), intern(value));
    attributes.push(encoded);
  }
  return {
    strings,
    documents: [
      {
        documentURL: 0,
        baseURL: 1,
        nodes: { nodeType, nodeName, nodeValue, parentIndex, attributes },
      },
    ],
  };
};

const captureSvg = (value: ReturnType<typeof svgDocument>) =>
  captureDom(value, new Set([origin]), input);

const urlFor = (
  result: ReturnType<typeof captureSvg>,
  nodeIndex: number,
): (typeof result.urls)[number] | undefined =>
  result.urls.find((url) => url.node_index === nodeIndex);

describe("SVG xlink:href destinations", () => {
  it("reports an SVG anchor that only has xlink:href, keeping the first value", () => {
    const result = captureSvg(
      svgDocument([
        { name: "svg", parent: 0 },
        { name: "g", parent: 1 },
        {
          name: "a",
          parent: 2,
          attributes: [
            ["xlink:href", "/xl-s2h"],
            ["xlink:href", "/later"],
          ],
        },
      ]),
    );
    expect(result.nodes[3]?.attribute_names).toEqual(["xlink:href"]);
    expect(result.urls).toEqual([
      {
        node_index: 3,
        attribute: "href",
        url: `${origin}/xl-s2h`,
        destination_scope: "approved",
      },
    ]);
  });

  it.each([
    ["xlink:href", "href"],
    ["href", "xlink:href"],
  ] as const)(
    "uses href when an SVG anchor also has xlink:href (%s then %s)",
    (first, second) => {
      const valueFor = (name: string): string =>
        name === "href" ? "/href-wins" : "/xlink-loses";
      const result = captureSvg(
        svgDocument([
          { name: "svg", parent: 0 },
          {
            name: "a",
            parent: 1,
            attributes: [
              [first, valueFor(first)],
              [second, valueFor(second)],
            ],
          },
        ]),
      );
      expect(result.urls).toEqual([
        {
          node_index: 2,
          attribute: "href",
          url: `${origin}/href-wins`,
          destination_scope: "approved",
        },
      ]);
    },
  );

  it("does not report xlink:href on an HTML anchor or a MathML element", () => {
    const result = captureSvg(
      svgDocument([
        {
          name: "A",
          parent: 0,
          attributes: [["xlink:href", "/xl-html"]],
        },
        { name: "math", parent: 0 },
        {
          name: "mrow",
          parent: 2,
          attributes: [["xlink:href", "/xl-math"]],
        },
        { name: "svg", parent: 0 },
        {
          name: "a",
          parent: 4,
          attributes: [["xlink:href", "/xl-s2h"]],
        },
      ]),
    );
    expect(result.nodes[1]?.attribute_names).toEqual(["xlink:href"]);
    expect(result.nodes[3]?.attribute_names).toEqual(["xlink:href"]);
    expect(urlFor(result, 1)).toBeUndefined();
    expect(urlFor(result, 3)).toBeUndefined();
    expect(urlFor(result, 5)?.url).toBe(`${origin}/xl-s2h`);
  });

  it("classifies an SVG xlink:href outside the allowed origins as outside_policy", () => {
    const result = captureSvg(
      svgDocument([
        { name: "svg", parent: 0 },
        {
          name: "a",
          parent: 1,
          attributes: [["xlink:href", "https://cdn.example.test/out"]],
        },
      ]),
    );
    expect(result.urls).toEqual([
      {
        node_index: 2,
        attribute: "href",
        url: null,
        destination_scope: "outside_policy",
      },
    ]);
  });

  it("resolves SVG image and use xlink:href against the document base", () => {
    const result = captureSvg(
      svgDocument([
        { name: "svg", parent: 0 },
        { name: "image", parent: 1, attributes: [["xlink:href", "guide"]] },
        { name: "use", parent: 1, attributes: [["xlink:href", "icon.svg"]] },
      ]),
    );
    expect(result.urls).toEqual([
      {
        node_index: 2,
        attribute: "href",
        url: `${origin}/screens/assets/guide`,
        destination_scope: "approved",
      },
      {
        node_index: 3,
        attribute: "href",
        url: `${origin}/screens/assets/icon.svg`,
        destination_scope: "approved",
      },
    ]);
  });
});

describe("SVG xlink:href context", () => {
  it("stops SVG context at foreignObject and resumes it for a nested svg", () => {
    const result = captureSvg(
      svgDocument([
        { name: "svg", parent: 0 },
        { name: "foreignObject", parent: 1 },
        {
          name: "A",
          parent: 2,
          attributes: [["xlink:href", "/xl-html-fo"]],
        },
        { name: "svg", parent: 2 },
        {
          name: "a",
          parent: 4,
          attributes: [["xlink:href", "/xl-nested"]],
        },
      ]),
    );
    expect(urlFor(result, 3)).toBeUndefined();
    expect(urlFor(result, 5)).toMatchObject({
      attribute: "href",
      url: `${origin}/xl-nested`,
      destination_scope: "approved",
    });
  });

  it("keeps an empty href ahead of xlink:href", () => {
    const baseUrl = `${origin}/screens/assets/`;
    const result = captureSvg(
      svgDocument(
        [
          { name: "svg", parent: 0 },
          {
            name: "a",
            parent: 1,
            attributes: [
              ["href", ""],
              ["xlink:href", "/xlink-should-lose"],
            ],
          },
        ],
        baseUrl,
      ),
    );
    expect(result.urls).toEqual([
      {
        node_index: 2,
        attribute: "href",
        url: baseUrl,
        destination_scope: "approved",
      },
    ]);
  });

  it("classifies a non-http SVG xlink:href as unsupported", () => {
    const result = captureSvg(
      svgDocument([
        { name: "svg", parent: 0 },
        {
          name: "a",
          parent: 1,
          attributes: [["xlink:href", "javascript:void(0)"]],
        },
      ]),
    );
    expect(result.urls).toEqual([
      {
        node_index: 2,
        attribute: "href",
        url: null,
        destination_scope: "unsupported",
      },
    ]);
  });

  it("does not treat a cyclic or dangling parent chain as SVG", () => {
    const cyclic = captureSvg(
      svgDocument([
        { name: "g", parent: 2 },
        {
          name: "a",
          parent: 1,
          attributes: [["xlink:href", "/cycle"]],
        },
      ]),
    );
    const dangling = captureSvg(
      svgDocument([
        {
          name: "a",
          parent: 99,
          attributes: [["xlink:href", "/missing-parent"]],
        },
      ]),
    );
    expect(cyclic.urls).toEqual([]);
    expect(dangling.urls).toEqual([]);
  });
});
