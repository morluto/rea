import { expect, it } from "vitest";
import { analyzeJavaScriptSemantics } from "./javascriptSemanticAnalysis.js";

const consumers = (source: string) =>
  analyzeJavaScriptSemantics(source).requestOperations.filter(
    ({ kind }) => kind === "response-consumer",
  );

it.each([
  'let response = await fetch("data:text/plain,original"); response = {text: () => "replacement"}; response.text();',
  'async function load(response) { response.text(); response = await fetch("data:text/plain,original"); }',
])(
  "qualifies a response candidate when its request does not prove the receiver: %s",
  (source) => {
    const result = consumers(source);
    expect(result).toMatchObject([{ endpoint: null, resolution: "partial" }]);
    expect(result[0]?.linkedRequestIds).toHaveLength(1);
  },
);

it("keeps a response whose request definitely reaches the read complete", () => {
  expect(
    consumers(
      'async function load(response) { response = await fetch("data:text/plain,original"); response.text(); }',
    ),
  ).toMatchObject([
    { endpoint: "data:text/plain,original", resolution: "complete" },
  ]);
});
