import { expect, it } from "vitest";
import { WebNetworkApiSurfaceAccumulator } from "../../domain/analysisView/WebNetworkApiSurfaceAccumulator.js";
import { decodeSazHttp } from "./SazHttp.js";
import { projectSazRecord } from "./SazProjection.js";

it.each([
  {
    ending: "\r\n",
    value: "\r\n\tapplication/json",
    types: ["application/json"],
  },
  { ending: "\n", value: "\n application/json", types: ["application/json"] },
  { ending: "\r\n", value: "\n application/json", types: [] },
  { ending: "\r\n", value: "\r\n \n application/json", types: [] },
  { ending: "\n", value: "\r application/json", types: [] },
  { ending: "\r\n", value: " application/json;\n charset=utf-8", types: [] },
])(
  "uses only parsed continuations for $ending framing and $value",
  ({ ending, value, types }) => {
    const response = decodeSazHttp(
      Buffer.from(
        `HTTP/1.1 200 OK${ending}Content-Type:${value}${ending}${ending}{}`,
      ),
      false,
    );
    const projected = projectSazRecord(
      {
        request: { method: "GET", url: "https://api.test/items/1" },
        response,
      },
      [],
    );
    expect(projected.reported).toMatchObject({
      response: { headers: [{ name: "Content-Type", value }] },
    });
    const accumulator = new WebNetworkApiSurfaceAccumulator();
    const result = accumulator.add(
      {
        ordinal: 0,
        location: { kind: "archive-members", members: ["raw/1_s.txt"] },
        ...projected,
        limitations: [],
      },
      "saz",
    );
    if (!result.ok) throw result.error;
    expect(accumulator.page(0, 1).groups[0]?.content_types).toEqual(types);
  },
);

it("redacts both spellings of folded credentials and explicitly sensitive headers", () => {
  const value = "\r\n\tapplication/json";
  const response = decodeSazHttp(
    Buffer.from(
      `HTTP/1.1 200 OK\r\nAuthorization: Bearer\r\n secret\r\nContent-Type:${value}\r\n\r\n`,
    ),
    false,
  );
  const projected = projectSazRecord({ response }, [value]);
  expect(projected.reported).toMatchObject({
    response: {
      headers: [
        { name: "Authorization", value: null, value_unfolded: null },
        { name: "Content-Type", value: null, value_unfolded: null },
      ],
    },
  });
  expect(JSON.stringify(projected)).not.toContain("Bearer");
  expect(JSON.stringify(projected)).not.toContain("secret");
  expect(JSON.stringify(projected)).not.toContain("application/json");
});

it.each([
  ["response", "Location", "\r\n"],
  ["response", "Location", "\n"],
  ["request", "Referer", "\r\n"],
  ["request", "Referer", "\n"],
  ["request", "Origin", "\r\n"],
  ["request", "Origin", "\n"],
])(
  "inherits URL credential exclusions for folded %s %s with %j framing",
  (side, name, ending) => {
    const message = decodeSazHttp(
      Buffer.from(
        `${side === "request" ? "GET / HTTP/1.1" : "HTTP/1.1 302 Found"}${ending}${name}: ht${ending}\ttps://user:synthetic-password-2884@api.test/${ending}${ending}`,
      ),
      side === "request",
    );
    const projected = projectSazRecord({ [side]: message }, []);
    expect(projected.reported).toMatchObject({
      [side]: { headers: [{ name, value: null, value_unfolded: null }] },
    });
    expect(projected.redactions).toEqual([
      { pointer: `/${side}/headers/0/value`, reason: "transport-credential" },
      {
        pointer: `/${side}/headers/0/value_unfolded`,
        reason: "transport-credential",
      },
    ]);
    expect(JSON.stringify(projected)).not.toContain("synthetic-password-2884");
  },
);

it("retains folded URL headers without credentials and ordinary extension text", () => {
  const value = " https://api.test/ordinary\r\n\tpath?token=ordinary";
  const extension = " ht\r\n\ttps://user:password@api.test/";
  const response = decodeSazHttp(
    Buffer.from(
      `HTTP/1.1 200 OK\r\nLocation:${value}\r\nX-Note:${extension}\r\n\r\n`,
    ),
    false,
  );
  const projected = projectSazRecord({ response }, []);
  expect(projected.reported).toMatchObject({
    response: {
      headers: [
        {
          name: "Location",
          value,
          value_unfolded: " https://api.test/ordinary path?token=ordinary",
        },
        {
          name: "X-Note",
          value: extension,
          value_unfolded: " ht tps://user:password@api.test/",
        },
      ],
    },
  });
  expect(projected.redactions).toEqual([]);
});
