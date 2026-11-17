import {
  TextReader,
  Uint8ArrayReader,
  Uint8ArrayWriter,
  ZipWriter,
} from "@zip.js/zip.js";
import { crc32 } from "node:zlib";

/** Real ZIP filename carriers and their independent, format-defined readings. */
export const NUPKG_NAME_ENCODING_CASES = [
  {
    encoding: "legacy",
    rawName: Buffer.from("6c69622f6e6574382e302f822e646c6c", "hex"),
    utf8: false,
    unicodePath: null,
    name: "lib/net8.0/é.dll",
    uncertain: true,
  },
  {
    encoding: "ascii",
    rawName: Buffer.from("lib/net8.0/demo.dll"),
    utf8: false,
    unicodePath: null,
    name: "lib/net8.0/demo.dll",
    uncertain: false,
  },
  {
    encoding: "utf8",
    rawName: Buffer.from("lib/net8.0/é.dll"),
    utf8: true,
    unicodePath: null,
    name: "lib/net8.0/é.dll",
    uncertain: false,
  },
  {
    encoding: "unicode-path",
    rawName: Buffer.from("6c69622f6e6574382e302f822e646c6c", "hex"),
    utf8: false,
    unicodePath: "lib/net8.0/café.dll",
    name: "lib/net8.0/café.dll",
    uncertain: false,
  },
] as const;

/** Inert package with an independently selected raw filename, EFS flag and Unicode Path claim. */
export const nugetNupkgNameEncodingFixture = async (
  input: (typeof NUPKG_NAME_ENCODING_CASES)[number],
): Promise<Uint8Array> => {
  const writer = new ZipWriter(new Uint8ArrayWriter(), {
    encodeText: (text, type) =>
      type === "filename" && text === "asset" ? input.rawName : undefined,
  });
  await writer.add("Demo.Package.nuspec", new TextReader(defaultNuspec), {
    level: 0,
  });
  let unicodeField: Buffer | undefined;
  if (input.unicodePath !== null) {
    const name = Buffer.from(input.unicodePath);
    unicodeField = Buffer.alloc(5 + name.length);
    unicodeField[0] = 1;
    unicodeField.writeUInt32LE(crc32(input.rawName), 1);
    name.copy(unicodeField, 5);
  }
  await writer.add("asset", new TextReader("benign asset bytes"), {
    level: 0,
    useUnicodeFileNames: input.utf8,
    ...(unicodeField === undefined
      ? {}
      : { extraField: new Map([[0x7075, unicodeField]]) }),
  });
  return writer.close();
};

const CONTENT_TYPES = `<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml" />
  <Default Extension="nuspec" ContentType="application/octet" />
  <Default Extension="dll" ContentType="application/octet" />
</Types>
`;

const relsXml = (
  target: string,
): string => `<?xml version="1.0" encoding="utf-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Type="http://schemas.microsoft.com/packaging/2010/07/manifest" Target="${target}" Id="R1" />
</Relationships>
`;

const defaultNuspec = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://schemas.microsoft.com/packaging/2013/05/nuspec.xsd">
  <metadata>
    <id>Demo.Package</id>
    <version>1.2.3</version>
    <authors>Alice, Bob</authors>
    <description>A tiny fixture package.</description>
    <license type="expression">MIT</license>
    <repository type="git" url="https://example.invalid/demo" commit="deadbeef" branch="main" />
    <dependencies>
      <group targetFramework="net8.0">
        <dependency id="Newtonsoft.Json" version="13.0.1" />
      </group>
      <group targetFramework="netstandard2.0">
        <dependency id="Newtonsoft.Json" version="[12.0.3,13.0.0)" exclude="Build,Analyzers" />
      </group>
    </dependencies>
  </metadata>
</package>
`;

export const ungroupedNuspec = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://schemas.microsoft.com/packaging/2010/07/nuspec.xsd">
  <metadata>
    <id>Ungrouped.Package</id>
    <version>0.1.0</version>
    <authors>Casey</authors>
    <description>Ungrouped dependencies.</description>
    <dependencies>
      <dependency id="Foo" version="1.0.0" include="Compile" developmentDependency="true" />
    </dependencies>
  </metadata>
</package>
`;

const addText = async (
  writer: ZipWriter<Uint8Array>,
  name: string,
  text: string,
): Promise<void> => {
  await writer.add(name, new TextReader(text), { level: 0 });
};

/** Inert ZIP with OPC relationships, a .nuspec, and conventional folders. */
export const nugetNupkgFixture = async (
  options: {
    readonly nuspec?: string;
    /** Exact .nuspec bytes, for encodings other than UTF-8. */
    readonly nuspecBytes?: Uint8Array;
    readonly nuspecName?: string;
    readonly relsTarget?: string;
    readonly extraMembers?: Readonly<Record<string, string>>;
    readonly includeRels?: boolean;
    readonly includeContentTypes?: boolean;
  } = {},
): Promise<Uint8Array> => {
  const writer = new ZipWriter(new Uint8ArrayWriter());
  const nuspecName = options.nuspecName ?? "Demo.Package.nuspec";
  if (options.includeContentTypes !== false)
    await addText(writer, "[Content_Types].xml", CONTENT_TYPES);
  if (options.includeRels !== false)
    await addText(
      writer,
      "_rels/.rels",
      relsXml(options.relsTarget ?? `/${nuspecName}`),
    );
  if (options.nuspecBytes === undefined)
    await addText(writer, nuspecName, options.nuspec ?? defaultNuspec);
  else
    await writer.add(nuspecName, new Uint8ArrayReader(options.nuspecBytes), {
      level: 0,
    });
  await writer.add(
    "lib/net8.0/Demo.dll",
    new Uint8ArrayReader(Uint8Array.from([0x4d, 0x5a])),
    { level: 0 },
  );
  await writer.add(
    "runtimes/win-x64/native/demo.dll",
    new Uint8ArrayReader(Uint8Array.from([0x00])),
    { level: 0 },
  );
  for (const [name, text] of Object.entries(options.extraMembers ?? {}))
    await addText(writer, name, text);
  return writer.close();
};

/** ZIP that is a valid archive but has no .nuspec. */
export const nugetNupkgMissingNuspecFixture = async (): Promise<Uint8Array> => {
  const writer = new ZipWriter(new Uint8ArrayWriter());
  await addText(writer, "[Content_Types].xml", CONTENT_TYPES);
  await writer.add(
    "lib/net8.0/Demo.dll",
    new Uint8ArrayReader(Uint8Array.from([0x4d, 0x5a])),
    { level: 0 },
  );
  return writer.close();
};

/** ZIP with two root .nuspec members and no OPC manifest relationship. */
export const nugetNupkgAmbiguousNuspecFixture =
  async (): Promise<Uint8Array> => {
    const writer = new ZipWriter(new Uint8ArrayWriter());
    await addText(writer, "First.nuspec", defaultNuspec);
    await addText(writer, "Second.nuspec", ungroupedNuspec);
    await writer.add(
      "lib/net8.0/Demo.dll",
      new Uint8ArrayReader(Uint8Array.from([0x4d, 0x5a])),
      { level: 0 },
    );
    return writer.close();
  };

/** ZIP whose only .nuspec is not well-formed XML. */
export const nugetNupkgMalformedNuspecFixture = async (): Promise<Uint8Array> =>
  nugetNupkgFixture({
    nuspec: "<package><metadata><id>Broken</id>",
    includeRels: false,
  });
