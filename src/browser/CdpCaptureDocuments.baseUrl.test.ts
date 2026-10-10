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
    value.strings.push("HREF", "second-guide");
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
