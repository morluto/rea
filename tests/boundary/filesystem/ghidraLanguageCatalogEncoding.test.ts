import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { ArtifactResourceScope } from "../../../src/resources/ArtifactResourceScope.js";
import { readGhidraLanguageCatalog } from "../../../src/ghidra/GhidraLanguageCatalog.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const xml =
  '<language_definitions><language id="toy:LE:32:default" description="�"><compiler id="default"/></language></language_definitions>';
const languageDirectory = async () => {
  const root = await createTestTempDirectory("rea-ghidra-xml-encoding-");
  const directory = join(root, "Ghidra/Processors/toy/data/languages");
  await mkdir(directory, { recursive: true });
  return { root, directory };
};

it("reads independent unsigned, UTF-8 BOM and UTF-16 BOM definitions together", async () => {
  const { root, directory } = await languageDirectory();
  const named = (id: string) =>
    xml.replace("toy:LE:32:default", `${id}:LE:32:default`);
  await writeFile(
    join(directory, "ascii.ldefs"),
    Buffer.from(named("unsigned")),
  );
  await writeFile(
    join(directory, "utf8.ldefs"),
    Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('<?xml version="1.0" encoding="UTF-8"?>' + named("utf8")),
    ]),
  );
  await writeFile(
    join(directory, "wide.ldefs"),
    Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from(
        '<?xml version="1.0" encoding="UTF-16"?>' + named("utf16"),
        "utf16le",
      ),
    ]),
  );
  expect(
    await readGhidraLanguageCatalog(root, new ArtifactResourceScope()),
  ).toEqual([
    { id: "unsigned:LE:32:default", compilerSpecIds: ["default"] },
    { id: "utf8:LE:32:default", compilerSpecIds: ["default"] },
    { id: "utf16:LE:32:default", compilerSpecIds: ["default"] },
  ]);
});

it.each([
  {
    name: "malformed UTF-8",
    bytes: Buffer.concat([
      Buffer.from('<language_definitions description="'),
      Buffer.from([0xff]),
      Buffer.from(
        '"><language id="toy:LE:32:default"/></language_definitions>',
      ),
    ]),
    expectedError: { reason: "invalid-bytes" },
  },
  {
    name: "encoding mismatch",
    bytes: Buffer.from('<?xml version="1.0" encoding="UTF-16"?>' + xml),
    expectedError: { reason: "encoding-mismatch" },
  },
  {
    name: "malformed XML alongside U+FFFD",
    bytes: Buffer.from(xml.replace('id="toy:LE:32:default"', "id=unquoted")),
    expectedError: { _tag: "ParseFailureError", kind: "malformed" },
  },
])(
  "preserves the failure for $name at the language-file byte boundary",
  async ({ bytes, expectedError }) => {
    const { root, directory } = await languageDirectory();
    await writeFile(join(directory, "toy.ldefs"), bytes);
    await expect(
      readGhidraLanguageCatalog(root, new ArtifactResourceScope()),
    ).rejects.toMatchObject(expectedError);
  },
);
