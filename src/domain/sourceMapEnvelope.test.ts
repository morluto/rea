import { expect, it } from "vitest";

import {
  inspectLocalSourceMapDeclarations,
  inspectSourceMapSourceContent,
} from "./sourceMapFormat.js";
import { selectedSourceMapLimits } from "./sourceMapLimits.js";

const inspect = (root: unknown) =>
  inspectLocalSourceMapDeclarations(JSON.stringify(root));

const leaf = {
  version: 3,
  mappings: "AAAA",
  sources: ["app.ts"],
  names: [],
};

it("applies observed-content policy to complete and partially invalid maps", () => {
  const replacement = { ...leaf, sourcesContent: ["\ufffd"] };
  const options = {
    hasObservedContent: (content: string) => /[^\ufffd]/u.test(content),
  };
  expect(
    inspectSourceMapSourceContent(JSON.stringify(replacement)).embedded,
  ).toBe(true);
  expect(
    inspectSourceMapSourceContent(JSON.stringify(replacement), options),
  ).toMatchObject({ embedded: false, complete: true });
  const indexed = (content: string) => ({
    version: 3,
    sections: [
      {
        offset: { line: 0, column: 0 },
        map: { ...leaf, sourcesContent: [content] },
      },
      { offset: { line: 1, column: 0 }, map: { ...leaf, mappings: "!" } },
    ],
  });
  expect(
    inspectSourceMapSourceContent(JSON.stringify(indexed("\ufffd")), options),
  ).toMatchObject({ embedded: false, complete: false });
  expect(
    inspectSourceMapSourceContent(JSON.stringify(indexed("source")), options),
  ).toMatchObject({ embedded: true, complete: false });
});

it("rejects non-version-3 roots and nested maps", () => {
  expect(inspect({ version: 3 })).toMatchObject({
    declarations: [],
    limitations: ["Source map has no sources array."],
  });
  expect(inspect(null)).toMatchObject({
    declarations: [],
    limitations: ["Source map is not a version 3 map."],
  });
  expect(inspect([{ version: 3 }])).toMatchObject({
    declarations: [],
    limitations: ["Source map is not a version 3 map."],
  });
  expect(inspect({ version: 2, mappings: "AAAA" })).toMatchObject({
    declarations: [],
    limitations: ["Source map is not a version 3 map."],
  });
  expect(inspect({ mappings: "AAAA" })).toMatchObject({
    declarations: [],
    limitations: ["Source map is not a version 3 map."],
  });
  expect(
    inspect({
      version: 3,
      sections: [
        {
          offset: { line: 0, column: 0 },
          map: { version: "3", sections: [] },
        },
      ],
    }),
  ).toMatchObject({
    invalid_sections: [
      {
        section_path: [0],
        reason: "Indexed source-map section map is not a version 3 map.",
      },
    ],
  });
});

it("does not traverse more local sections than the format reader admits", () => {
  const observed = inspectLocalSourceMapDeclarations(
    JSON.stringify({
      version: 3,
      sections: [
        { offset: { line: 0, column: 0 }, map: leaf },
        { offset: { line: 1, column: 0 }, map: leaf },
      ],
    }),
    { limits: selectedSourceMapLimits({ decoded_records: 1 }) },
  );
  expect(observed.declarations).toEqual([]);
  expect(observed.invalid_sections).toEqual([
    {
      section_path: [],
      reason: "Local source-map inspection exceeded decoded_records (1).",
    },
  ]);
});
