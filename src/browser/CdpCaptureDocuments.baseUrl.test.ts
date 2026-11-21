import { describe, expect, it } from "vitest";

import { inspectWebPageInputSchema } from "../domain/browserObservation.js";
import { captureDom } from "./CdpCaptureDocuments.js";
import { capturedSvgNodeKind } from "./CdpCaptureDomNamespaces.js";
import { CdpCaptureCompleteness } from "./CdpCaptureCompleteness.js";

const origin = "https://app.example.test";
const documentUrl = `${origin}/screens/app`;
const input = inspectWebPageInputSchema.parse({
  cdp_endpoint: "http://127.0.0.1:9222",
  allowed_origins: [origin],
  target_id: "page-1",
});

it("splits link relations only on HTML ASCII whitespace", () => {
  const result = captureSnapshot(
    domSnapshot([
      {
        name: "LINK",
        parent: 0,
        attributes: [
          ["href", "/valid"],
          [
            "rel",
            "alternate\u00a0mcp alternate\u000bmodel-context alternate\u2003ai-plugin alternate\ufeffservice-desc mcp\tservice-desc",
          ],
        ],
      },
    ]),
  );
  expect(
    result.agentHints.map(({ declaration, url }) => ({ declaration, url })),
  ).toEqual([
    { declaration: "mcp", url: `${origin}/valid` },
    { declaration: "service-desc", url: `${origin}/valid` },
  ]);
});

it("uses the captured base for relative destinations and falls back to the document URL", () => {
  const elements: SnapshotElement[] = [
    { name: "BASE", parent: 0, attributes: [["href", "assets/"]] },
    { name: "A", parent: 0, attributes: [["href", "guide"]] },
    {
      name: "LINK",
      parent: 0,
      attributes: [
        ["href", "agent"],
        ["rel", "mcp"],
      ],
    },
    { name: "FORM", parent: 0, attributes: [["action", "submit"]] },
  ];
  for (const [base, resolved] of [
    [`${origin}/screens/assets/`, `${origin}/screens/assets/`],
    [null, `${origin}/screens/`],
  ] as const) {
    const result = captureSnapshot(domSnapshot(elements, base));
    expect(result.urls).toEqual([
      approvedHref(1, `${origin}/screens/assets/`),
      approvedHref(2, `${resolved}guide`),
      approvedHref(3, `${resolved}agent`),
      {
        node_index: 4,
        attribute: "action",
        url: `${resolved}submit`,
        destination_scope: "approved",
      },
    ]);
    expect(result.agentHints).toEqual([
      {
        mechanism: "dom_link_rel",
        declaration: "mcp",
        url: `${resolved}agent`,
        trust: "page-declared-untrusted",
      },
    ]);
  }
});

it("applies destination policy after resolution against a foreign base", () => {
  const foreign = "https://cdn.example.test/assets/";
  const result = captureSnapshot(
    domSnapshot(
      [
        { name: "BASE", parent: 0, attributes: [["href", foreign]] },
        { name: "A", parent: 0, attributes: [["href", "guide"]] },
        {
          name: "LINK",
          parent: 0,
          attributes: [
            ["href", "agent"],
            ["rel", "mcp"],
          ],
        },
        { name: "FORM", parent: 0, attributes: [["action", "submit"]] },
        {
          name: "A",
          parent: 0,
          attributes: [["href", `${origin}/absolute`]],
        },
        { name: "FORM", parent: 0, attributes: [["action", ""]] },
      ],
      foreign,
    ),
  );
  expect(result.urls).toEqual([
    {
      node_index: 1,
      attribute: "href",
      url: null,
      destination_scope: "outside_policy",
    },
    {
      node_index: 2,
      attribute: "href",
      url: null,
      destination_scope: "outside_policy",
    },
    {
      node_index: 3,
      attribute: "href",
      url: null,
      destination_scope: "outside_policy",
    },
    {
      node_index: 4,
      attribute: "action",
      url: null,
      destination_scope: "outside_policy",
    },
    approvedHref(5, `${origin}/absolute`),
    {
      node_index: 6,
      attribute: "action",
      url: documentUrl,
      destination_scope: "approved",
    },
  ]);
  expect(result.agentHints).toEqual([
    {
      mechanism: "dom_link_rel",
      declaration: "mcp",
      url: null,
      trust: "page-declared-untrusted",
    },
  ]);
  expect(result.nodes.map(({ node_name }) => node_name)).toEqual([
    "#document",
    "BASE",
    "A",
    "LINK",
    "FORM",
    "A",
    "FORM",
  ]);
});

it("retains unsupported URL evidence and redacts credentials on approved links", () => {
  const result = captureSnapshot(
    domSnapshot(
      [
        "javascript:void(0)",
        "mailto:someone@example.test",
        "data:text/plain,hello",
        "ftp://app.example.test/file",
        "https://[invalid",
        "https://user:secret@app.example.test/guide",
      ].map((href) => ({
        name: "A",
        parent: 0,
        attributes: [["href", href]],
      })),
      null,
    ),
  );
  expect(result.urls).toEqual([
    ...[1, 2, 3, 4, 5].map((node_index) => ({
      node_index,
      attribute: "href",
      url: null,
      destination_scope: "unsupported",
    })),
    approvedHref(6, `${origin}/guide`),
  ]);
});

it("does not authorize a foreign document using its approved base URL", () => {
  const result = captureSnapshot(
    domSnapshot(
      [
        {
          name: "LINK",
          parent: 0,
          attributes: [
            ["href", "/agent"],
            ["rel", "mcp"],
          ],
        },
      ],
      `${origin}/assets/`,
      "https://outside.example.test/app",
    ),
  );
  expect(result.nodes).toEqual([]);
  expect(result.urls).toEqual([]);
  expect(result.agentHints).toEqual([]);
});

it("resolves a prefixed XHTML base against the document and empty actions to the document URL", () => {
  const page = `${origin}/root/prefixed.xhtml`;
  const result = captureSnapshot(
    domSnapshot(
      [
        {
          name: "h:html",
          parent: 0,
          attributes: [["xmlns:h", XHTML_NAMESPACE]],
        },
        { name: "h:base", parent: 1, attributes: [["href", "assets/"]] },
        { name: "h:form", parent: 1, attributes: [["action", ""]] },
        { name: "h:button", parent: 3, attributes: [["formaction", ""]] },
      ],
      `${origin}/root/assets/`,
      page,
    ),
  );
  expect(result.urls).toEqual([
    approvedHref(2, `${origin}/root/assets/`),
    {
      node_index: 3,
      attribute: "action",
      url: page,
      destination_scope: "approved",
    },
    {
      node_index: 4,
      attribute: "formaction",
      url: page,
      destination_scope: "approved",
    },
  ]);
});

it("distinguishes HTML form whitespace from submit control and generic action values", () => {
  const base = `${origin}/assets/`;
  const elements = [
    ["FORM", "action", " ", documentUrl],
    ["FORM", "action", "\t\r\n\f", documentUrl],
    ["FORM", "action", "\u000b", base],
    ["FORM", "action", "\u00a0", `${base}%C2%A0`],
    ["BUTTON", "formaction", " ", base],
    ["INPUT", "formaction", " ", base],
    ["DIV", "action", "", base],
  ] as const;
  const result = captureSnapshot(
    domSnapshot(
      elements.map(([name, attribute, value]) => ({
        name,
        parent: 0,
        attributes: [[attribute, value]],
      })),
      base,
    ),
  );
  expect(result.urls).toEqual(
    elements.map(([, attribute, , url], index) => ({
      node_index: index + 1,
      attribute,
      url,
      destination_scope: "approved",
    })),
  );
});

it("preserves case-sensitive SVG attributes and keeps the first duplicate HTML href", () => {
  const result = captureSnapshot(
    domSnapshot(
      [
        {
          name: "A",
          parent: 0,
          attributes: [
            ["href", "guide"],
            ["href", "/later"],
          ],
        },
        { name: "svg", parent: 0 },
        {
          name: "a",
          parent: 2,
          attributes: [
            ["HREF", "/wrong"],
            ["href", "/actual"],
            ["viewBox", "0 0 10 10"],
            ["viewbox", "0 0 10 10"],
          ],
        },
      ],
      null,
    ),
  );
  expect(result.nodes[1]?.attribute_names).toEqual(["href"]);
  expect(result.nodes[3]?.attribute_names).toEqual([
    "HREF",
    "href",
    "viewBox",
    "viewbox",
  ]);
  expect(result.urls).toEqual([
    approvedHref(1, `${origin}/screens/guide`),
    approvedHref(3, `${origin}/actual`),
  ]);
});

interface SnapshotElement {
  readonly name: string;
  readonly parent: number;
  readonly attributes?: readonly (readonly [string, string])[];
  readonly svg?: boolean;
}

const domSnapshot = (
  elements: readonly SnapshotElement[],
  baseUrl: string | null = `${origin}/screens/assets/`,
  pageUrl = documentUrl,
) => {
  const strings = [pageUrl, baseUrl ?? ""];
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
  const backendNodeId = [1];
  const svgNodeKinds = new Map<string, boolean>();
  for (const element of elements) {
    const id = backendNodeId.length + 1;
    backendNodeId.push(id);
    if (element.svg !== undefined)
      svgNodeKinds.set(`${String(id)}:${element.name}`, element.svg);
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
        ...(baseUrl === null ? {} : { baseURL: 1 }),
        nodes: {
          nodeType,
          nodeName,
          nodeValue,
          parentIndex,
          attributes,
          backendNodeId,
        },
        svgNodeKinds,
      },
    ],
  };
};

const captureSnapshot = (value: ReturnType<typeof domSnapshot>) => {
  const kinds = new Map(
    value.documents.flatMap((document) => [...document.svgNodeKinds]),
  );
  const capture = captureDom(value, new Set([origin]), input);
  let step = capture.next();
  while (!step.done) {
    step = capture.next(
      step.value.map((query) =>
        kinds.get(`${String(query.backendNodeId)}:${query.nodeName}`),
      ),
    );
  }
  return step.value;
};

const urlFor = (
  result: ReturnType<typeof captureSnapshot>,
  nodeIndex: number,
): (typeof result.urls)[number] | undefined =>
  result.urls.find((url) => url.node_index === nodeIndex);

describe("browser SVG identity", () => {
  const query = { backendNodeId: 42, nodeName: "a" };
  const node = { ...query, nodeType: 1 };

  it("uses only a matching described element's SVG flag", () => {
    expect(capturedSvgNodeKind(query, { node: { ...node, isSVG: true } })).toBe(
      true,
    );
    expect(
      capturedSvgNodeKind(query, { node: { ...node, isSVG: false } }),
    ).toBe(false);
    expect(capturedSvgNodeKind(query, { node })).toBe(false);
    for (const invalid of [
      { node: { ...node, backendNodeId: 43, isSVG: true } },
      { node: { ...node, nodeName: "A", isSVG: true } },
      { node: { ...node, nodeType: 3, isSVG: true } },
    ])
      expect(capturedSvgNodeKind(query, invalid)).toBeUndefined();
  });

  it("distinguishes identically named SVG and MathML elements regardless of parent", () => {
    const result = captureSnapshot(
      domSnapshot([
        { name: "svg", parent: 0 },
        { name: "desc", parent: 1 },
        {
          name: "a",
          svg: true,
          parent: 2,
          attributes: [["xlink:href", "/svg"]],
        },
        {
          name: "a",
          svg: false,
          parent: 2,
          attributes: [["xlink:href", "/math"]],
        },
        {
          name: "A",
          svg: false,
          parent: 1,
          attributes: [["xlink:href", "/html"]],
        },
        {
          name: "a",
          svg: true,
          parent: 0,
          attributes: [["xlink:href", "/orphan"]],
        },
      ]),
    );
    expect(result.urls.map(({ url }) => url)).toEqual([
      `${origin}/svg`,
      `${origin}/orphan`,
    ]);
  });

  it("records unresolved identity without inventing a destination or hiding attributes", () => {
    const value = domSnapshot([
      { name: "a", parent: 0, attributes: [["xlink:href", "/unknown"]] },
    ]);
    const completeness = new CdpCaptureCompleteness();
    const capture = captureDom(value, new Set([origin]), input, completeness);
    expect(capture.next()).toEqual({
      done: false,
      value: [{ backendNodeId: 2, nodeName: "a" }],
    });
    const step = capture.next([undefined]);
    expect(step.done).toBe(true);
    if (!step.done) throw new Error("Unexpected second query");
    expect(step.value.unresolvedSvgNodes).toBe(1);
    expect(step.value.urls).toEqual([]);
    expect(step.value.nodes[1]?.attribute_names).toEqual(["xlink:href"]);
    expect(completeness.snapshot().excluded).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          section: "metadata",
          reason: "provider_unavailable",
          count: 1,
        }),
      ]),
    );
  });
});

it("keeps batched SVG identities aligned around missing IDs and ordinary links", () => {
  const value = domSnapshot([
    { name: "a", parent: 0, attributes: [["xlink:href", "/svg"]] },
    { name: "A", parent: 0, attributes: [["href", "/ordinary"]] },
    { name: "a", parent: 0, attributes: [["xlink:href", "/missing-id"]] },
    { name: "a", parent: 0, attributes: [["xlink:href", "/non-svg"]] },
  ]);
  const completeness = new CdpCaptureCompleteness();
  const capture = captureDom(
    {
      ...value,
      documents: value.documents.map((document) => ({
        ...document,
        nodes: { ...document.nodes, backendNodeId: [1, 2, 3, null, 5] },
      })),
    },
    new Set([origin]),
    input,
    completeness,
  );
  expect(capture.next()).toEqual({
    done: false,
    value: [
      { backendNodeId: 2, nodeName: "a" },
      { backendNodeId: 5, nodeName: "a" },
    ],
  });
  const step = capture.next([true, false]);
  if (!step.done) throw new Error("Unexpected second batch");
  expect(
    step.value.urls.map(({ node_index, url }) => [node_index, url]),
  ).toEqual([
    [1, `${origin}/svg`],
    [2, `${origin}/ordinary`],
  ]);
  expect(step.value.unresolvedSvgNodes).toBe(1);
  expect(completeness.snapshot().excluded).toContainEqual({
    section: "metadata",
    reason: "provider_unavailable",
    count: 1,
  });
});

describe("SVG xlink:href destinations", () => {
  it("keeps the first XLink value and gives plain href precedence in either order", () => {
    const baseUrl = `${origin}/screens/assets/`;
    const attributesByAnchor = [
      [
        ["xlink:href", "/first"],
        ["xlink:href", "/duplicate"],
      ],
      [
        ["xlink:href", "/decoy"],
        ["href", "/href-after"],
      ],
      [
        ["href", "/href-before"],
        ["xlink:href", "/decoy"],
      ],
      [
        ["href", ""],
        ["xlink:href", "/decoy"],
      ],
    ] as const;
    const result = captureSnapshot(
      domSnapshot(
        [
          { name: "svg", parent: 0 },
          { name: "g", parent: 1 },
          ...attributesByAnchor.map((attributes) => ({
            name: "a",
            svg: true,
            parent: 2,
            attributes,
          })),
        ],
        baseUrl,
      ),
    );
    expect(result.nodes[3]?.attribute_names).toEqual(["xlink:href"]);
    expect(result.urls).toEqual([
      approvedHref(3, `${origin}/first`),
      approvedHref(4, `${origin}/href-after`),
      approvedHref(5, `${origin}/href-before`),
      approvedHref(6, baseUrl),
    ]);
  });

  it("does not report xlink:href on an HTML anchor or a MathML element", () => {
    const result = captureSnapshot(
      domSnapshot([
        {
          name: "A",
          svg: false,
          parent: 0,
          attributes: [["xlink:href", "/xl-html"]],
        },
        { name: "math", parent: 0 },
        {
          name: "mrow",
          svg: false,
          parent: 2,
          attributes: [["xlink:href", "/xl-math"]],
        },
        { name: "svg", parent: 0 },
        {
          name: "a",
          svg: true,
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

  it("resolves SVG image and use links against the base and preserves scope outcomes", () => {
    const result = captureSnapshot(
      domSnapshot([
        { name: "svg", parent: 0 },
        {
          name: "image",
          svg: true,
          parent: 1,
          attributes: [["xlink:href", "guide"]],
        },
        {
          name: "use",
          svg: true,
          parent: 1,
          attributes: [["xlink:href", "icon.svg"]],
        },
        {
          name: "a",
          svg: true,
          parent: 1,
          attributes: [["xlink:href", "https://cdn.example.test/out"]],
        },
        {
          name: "a",
          svg: true,
          parent: 1,
          attributes: [["xlink:href", "javascript:void(0)"]],
        },
      ]),
    );
    expect(result.urls).toEqual([
      approvedHref(2, `${origin}/screens/assets/guide`),
      approvedHref(3, `${origin}/screens/assets/icon.svg`),
      {
        node_index: 4,
        attribute: "href",
        url: null,
        destination_scope: "outside_policy",
      },
      {
        node_index: 5,
        attribute: "href",
        url: null,
        destination_scope: "unsupported",
      },
    ]);
  });
});

describe("SVG xlink:href context", () => {
  it("binds SVG identity to the selected element across documents", () => {
    const svg = domSnapshot([
      {
        name: "a",
        svg: true,
        parent: 2,
        attributes: [["xlink:href", "/svg-link"]],
      },
      { name: "g", parent: 3 },
      { name: "svg", parent: 0 },
    ]);
    const html = domSnapshot([
      {
        name: "A",
        svg: false,
        parent: 2,
        attributes: [["xlink:href", "/html-link"]],
      },
      { name: "DIV", parent: 3 },
      { name: "BODY", parent: 0 },
    ]);
    const offset = svg.strings.length;
    const result = captureSnapshot({
      strings: [...svg.strings, ...html.strings],
      documents: [
        ...svg.documents,
        ...html.documents.map((document) => ({
          ...document,
          documentURL: document.documentURL + offset,
          ...(document.baseURL === undefined
            ? {}
            : { baseURL: document.baseURL + offset }),
          nodes: {
            ...document.nodes,
            nodeName: document.nodes.nodeName.map((index) => index + offset),
            nodeValue: document.nodes.nodeValue.map((index) => index + offset),
            attributes: document.nodes.attributes.map((attributes) =>
              attributes.map((index) => index + offset),
            ),
          },
        })),
      ],
    });
    expect(result.urls).toEqual([
      {
        node_index: 1,
        attribute: "href",
        url: `${origin}/svg-link`,
        destination_scope: "approved",
      },
    ]);
  });

  it("preserves browser SVG identity across HTML integration points", () => {
    const result = captureSnapshot(
      domSnapshot([
        { name: "svg", parent: 0 },
        ...["foreignObject", "desc", "title"].flatMap((name, index) => {
          const parent = 2 + index * 4;
          return [
            { name, parent: 1 },
            {
              name: "A",
              svg: false,
              parent,
              attributes: [["xlink:href", `/html-${name}`]],
            },
            { name: "svg", parent },
            {
              name: "a",
              svg: true,
              parent: parent + 2,
              attributes: [["xlink:href", `/svg-${name}`]],
            },
          ] satisfies SnapshotElement[];
        }),
      ]),
    );
    expect(result.urls).toEqual([
      approvedHref(5, `${origin}/svg-foreignObject`),
      approvedHref(9, `${origin}/svg-desc`),
      approvedHref(13, `${origin}/svg-title`),
    ]);
  });
});

describe("unavailable SVG identity", () => {
  it("keeps an unavailable SVG identity unknown despite ancestor names", () => {
    const cyclic = captureSnapshot(
      domSnapshot([
        { name: "g", parent: 2 },
        {
          name: "a",
          parent: 1,
          attributes: [
            ["xmlns:svg", SVG_NAMESPACE],
            ["xmlns:xlink", XLINK_NAMESPACE],
            ["xlink:href", "/cycle"],
          ],
        },
      ]),
    );
    const dangling = captureSnapshot(
      domSnapshot([
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

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const XLINK_NAMESPACE = "http://www.w3.org/1999/xlink";
const XHTML_NAMESPACE = "http://www.w3.org/1999/xhtml";

const xhtmlRoot = (
  attributes: readonly (readonly [string, string])[] = [
    ["xmlns", XHTML_NAMESPACE],
    ["xmlns:svg", SVG_NAMESPACE],
    ["xmlns:xlink", XLINK_NAMESPACE],
  ],
): SnapshotElement => ({
  name: "html",
  parent: 0,
  attributes,
});

const approvedHref = (
  nodeIndex: number,
  url: string,
): {
  readonly node_index: number;
  readonly attribute: "href";
  readonly url: string;
  readonly destination_scope: "approved";
} => ({
  node_index: nodeIndex,
  attribute: "href",
  url,
  destination_scope: "approved",
});

it("publishes agent hints only from XHTML link elements", () => {
  const relations = "mcp model-context ai-plugin service-desc";
  const result = captureSnapshot(
    domSnapshot([
      {
        name: "h:html",
        parent: 0,
        attributes: [
          ["xmlns", XHTML_NAMESPACE],
          ["xmlns:h", XHTML_NAMESPACE],
          ["xmlns:f", "urn:foreign"],
        ],
      },
      {
        name: "link",
        parent: 1,
        attributes: [
          ["href", "/default-hint"],
          ["rel", relations],
        ],
      },
      {
        name: "h:link",
        parent: 1,
        attributes: [
          ["href", "/prefixed-hint"],
          ["rel", relations],
        ],
      },
      {
        name: "f:link",
        parent: 1,
        attributes: [
          ["href", "/foreign-decoy"],
          ["rel", "mcp"],
        ],
      },
      {
        name: "LINK",
        parent: 1,
        attributes: [
          ["href", "/uppercase-decoy"],
          ["rel", "mcp"],
        ],
      },
    ]),
  );
  expect(result.agentHints).toEqual(
    ["/default-hint", "/prefixed-hint"].flatMap((path) =>
      ["mcp", "model-context", "ai-plugin", "service-desc"].map(
        (declaration) => ({
          mechanism: "dom_link_rel",
          declaration,
          url: `${origin}${path}`,
          trust: "page-declared-untrusted",
        }),
      ),
    ),
  );
});

describe("XML SVG roots and namespace scope restoration", () => {
  it("resolves explicit namespaces under both SVG and generic unprefixed roots", () => {
    for (const name of ["svg", "document"]) {
      const result = captureSnapshot(
        domSnapshot([
          {
            name,
            parent: 0,
            attributes: [
              ["xmlns", SVG_NAMESPACE],
              ["xmlns:p", XLINK_NAMESPACE],
            ],
          },
          {
            name: "a",
            parent: 1,
            attributes: [["p:href", "/linked"]],
          },
        ]),
      );
      expect(result.urls, name).toEqual([approvedHref(2, `${origin}/linked`)]);
    }
  });

  it("retains only links with readable XML ancestry", () => {
    const result = captureSnapshot(
      domSnapshot([
        xhtmlRoot(),
        {
          name: "svg:a",
          parent: 2,
          attributes: [
            ["xmlns:svg", SVG_NAMESPACE],
            ["xmlns:xlink", XLINK_NAMESPACE],
            ["xlink:href", "/self-parent"],
          ],
        },
        {
          name: "svg:a",
          parent: 4,
          attributes: [
            ["xmlns:svg", SVG_NAMESPACE],
            ["xmlns:xlink", XLINK_NAMESPACE],
            ["xlink:href", "/cycle"],
          ],
        },
        { name: "svg:g", parent: 3 },
        {
          name: "svg:a",
          parent: 99,
          attributes: [
            ["xmlns:svg", SVG_NAMESPACE],
            ["xmlns:xlink", XLINK_NAMESPACE],
            ["xlink:href", "/dangling"],
          ],
        },
        { name: "svg:a", parent: 1, attributes: [["xlink:href", "/admitted"]] },
      ]),
    );
    expect(result.urls).toEqual([approvedHref(6, `${origin}/admitted`)]);
  });

  it("applies local declarations and restores namespace scope for siblings", () => {
    const result = captureSnapshot(
      domSnapshot([
        xhtmlRoot(),
        {
          name: "svg:a",
          parent: 1,
          attributes: [["xlink:href", "/before-undeclaration"]],
        },
        {
          name: "svg:a",
          parent: 1,
          attributes: [
            ["xmlns:xlink", ""],
            ["xlink:href", "/undeclared"],
          ],
        },
        {
          name: "svg:a",
          parent: 1,
          attributes: [["xlink:href", "/inherited"]],
        },
        {
          name: "svg:a",
          parent: 1,
          attributes: [
            ["xmlns:svg", "other"],
            ["xlink:href", "/rebound"],
          ],
        },
        { name: "svg:a", parent: 1, attributes: [["xlink:href", "/restored"]] },
        {
          name: "local:a",
          parent: 1,
          attributes: [["xlink:href", "/leaked-before-declaration"]],
        },
        {
          name: "local:a",
          parent: 1,
          attributes: [
            ["p:href", "/local-declaration"],
            ["xmlns:local", SVG_NAMESPACE],
            ["xmlns:p", XLINK_NAMESPACE],
          ],
        },
        {
          name: "local:a",
          parent: 1,
          attributes: [["xlink:href", "/leaked-declaration"]],
        },
      ]),
    );
    expect(result.urls).toEqual([
      approvedHref(2, `${origin}/before-undeclaration`),
      approvedHref(4, `${origin}/inherited`),
      approvedHref(6, `${origin}/restored`),
      approvedHref(8, `${origin}/local-declaration`),
    ]);
  });
});

it("resolves XLink aliases in scope and keeps plain href ahead of them", () => {
  const anchor = (
    parent: number,
    attributes: readonly (readonly [string, string])[],
  ): SnapshotElement => ({ name: "svg:a", parent, attributes });
  const result = captureSnapshot(
    domSnapshot([
      xhtmlRoot(),
      { name: "svg:svg", parent: 1 },
      anchor(2, [
        ["xlink:href", "/first-duplicate"],
        ["xlink:href", "/later-duplicate"],
      ]),
      { name: "svg:image", parent: 2, attributes: [["xlink:href", "guide"]] },
      anchor(1, [["xlink:href", "/without-svg-parent"]]),
      anchor(1, [
        ["x:href", "/alias-out-of-scope"],
        ["xlink:href", "/restored"],
      ]),
      {
        name: "svg",
        parent: 1,
        attributes: [
          ["xmlns", SVG_NAMESPACE],
          ["xmlns:xlink", "urn:not-xlink"],
          ["xmlns:x", XLINK_NAMESPACE],
        ],
      },
      {
        name: "a",
        svg: true,
        parent: 7,
        attributes: [
          ["xlink:href", "/wrong-namespace"],
          ["x:href", "/first-custom"],
          ["x:href", "/later-custom"],
        ],
      },
      { name: "svg:g", parent: 2, attributes: [["xmlns:p", XLINK_NAMESPACE]] },
      anchor(9, [
        ["p:href", "/alias-first"],
        ["xlink:href", "/literal-later"],
      ]),
      anchor(9, [
        ["xlink:href", "/literal-first"],
        ["p:href", "/alias-later"],
      ]),
      anchor(9, [
        ["p:href", "/xlink-loses"],
        ["href", "/plain-after"],
      ]),
      anchor(9, [
        ["href", "/plain-before"],
        ["xlink:href", "/xlink-loses"],
      ]),
      anchor(9, [
        ["href", ""],
        ["p:href", "/empty-plain-wins"],
      ]),
    ]),
  );

  expect(result.nodes[3]).toMatchObject({
    node_name: "svg:a",
    attribute_names: ["xlink:href"],
  });
  expect(result.nodes[8]?.attribute_names).toEqual(["xlink:href", "x:href"]);
  expect(result.urls).toEqual([
    approvedHref(3, `${origin}/first-duplicate`),
    approvedHref(4, `${origin}/screens/assets/guide`),
    approvedHref(5, `${origin}/without-svg-parent`),
    approvedHref(6, `${origin}/restored`),
    approvedHref(8, `${origin}/first-custom`),
    approvedHref(10, `${origin}/alias-first`),
    approvedHref(11, `${origin}/literal-first`),
    approvedHref(12, `${origin}/plain-after`),
    approvedHref(13, `${origin}/plain-before`),
    approvedHref(14, `${origin}/screens/assets/`),
  ]);
});

it("distinguishes SVG elements inside foreignObject from foreign element namespaces and blocked destinations", () => {
  const result = captureSnapshot(
    domSnapshot([
      xhtmlRoot([
        ["xmlns", XHTML_NAMESPACE],
        ["xmlns:svg", SVG_NAMESPACE],
        ["xmlns:xlink", XLINK_NAMESPACE],
        ["xmlns:h", XHTML_NAMESPACE],
        ["xmlns:bogus", "urn:not-svg"],
      ]),
      { name: "svg:svg", parent: 1 },
      { name: "svg:foreignObject", parent: 2 },
      {
        name: "a",
        svg: true,
        parent: 3,
        attributes: [["xlink:href", "/xhtml"]],
      },
      {
        name: "h:a",
        parent: 3,
        attributes: [["xlink:href", "/prefixed-xhtml"]],
      },
      {
        name: "svg:a",
        parent: 3,
        attributes: [["xlink:href", "/foreign-object-svg"]],
      },
      {
        name: "bogus:svg",
        parent: 1,
        attributes: [["xlink:href", "/foreign-root"]],
      },
      {
        name: "bogus:a",
        parent: 7,
        attributes: [["xlink:href", "/foreign-anchor"]],
      },
      { name: "svg:a", parent: 1, attributes: [["xlink:href", "/kept"]] },
      {
        name: "svg:a",
        parent: 3,
        attributes: [["xlink:href", "https://cdn.example.test/out"]],
      },
    ]),
  );
  expect(result.nodes[7]?.node_name).toBe("bogus:svg");
  expect(result.urls).toEqual([
    approvedHref(6, `${origin}/foreign-object-svg`),
    approvedHref(9, `${origin}/kept`),
    {
      node_index: 10,
      attribute: "href",
      url: null,
      destination_scope: "outside_policy",
    },
  ]);
});

it("leaves HTML documents on literal svg and xlink:href names", () => {
  const result = captureSnapshot(
    domSnapshot([
      { name: "HTML", parent: 0 },
      {
        name: "svg",
        parent: 1,
        attributes: [
          ["xmlns", SVG_NAMESPACE],
          ["xmlns:x", XLINK_NAMESPACE],
        ],
      },
      {
        name: "a",
        svg: true,
        parent: 2,
        attributes: [["xlink:href", "/xl-literal"]],
      },
      {
        name: "a",
        svg: true,
        parent: 2,
        attributes: [["x:href", "/xl-custom-html"]],
      },
      {
        name: "svg:a",
        parent: 1,
        attributes: [
          ["xmlns:svg", SVG_NAMESPACE],
          ["xmlns:xlink", XLINK_NAMESPACE],
          ["xlink:href", "/xl-prefixed-html"],
        ],
      },
      {
        name: "A",
        svg: false,
        parent: 1,
        attributes: [["xlink:href", "/xl-html-anchor"]],
      },
    ]),
  );
  expect(result.urls).toEqual([approvedHref(3, `${origin}/xl-literal`)]);
});

describe("XML namespace resolution ordering and capacity", () => {
  it("resolves a prefix declared on a later ancestor", () => {
    const result = captureSnapshot(
      domSnapshot([
        {
          name: "svg:a",
          parent: 2,
          attributes: [["xlink:href", "/forward"]],
        },
        { name: "svg:svg", parent: 3 },
        xhtmlRoot(),
      ]),
    );
    expect(result.urls).toEqual([approvedHref(1, `${origin}/forward`)]);
  });

  it("resolves a deep chain with distinct namespace declarations without quadratic expansion", () => {
    const depth = 12_000;
    const elements: SnapshotElement[] = [
      xhtmlRoot(),
      { name: "svg:svg", parent: 1 },
    ];
    let parent = 2;
    for (let index = 0; index < depth; index += 1) {
      elements.push({
        name: "svg:g",
        parent,
        attributes: [[`xmlns:p${index}`, `urn:prefix:${index}`]],
      });
      parent = elements.length;
    }
    elements.push({
      name: "svg:a",
      parent,
      attributes: [["xlink:href", "/deep"]],
    });
    const snapshot = domSnapshot(elements);
    const result = captureSnapshot(snapshot);
    expect(result.urls).toEqual([
      approvedHref(elements.length, `${origin}/deep`),
    ]);
  });
});
