import {
  TextReader,
  Uint8ArrayReader,
  Uint8ArrayWriter,
  ZipWriter,
} from "@zip.js/zip.js";

const CONTENT_TYPES = `<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="json" ContentType="application/json" />
  <Default Extension="vsixmanifest" ContentType="text/xml" />
  <Default Extension="js" ContentType="application/javascript" />
</Types>
`;

export const defaultVsixManifest = `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
  <Metadata>
    <Identity Id="demo.hello" Version="1.2.3" Publisher="demo" TargetPlatform="win32-x64" />
    <DisplayName>Hello Demo</DisplayName>
    <Description xml:space="preserve">A tiny fixture extension.</Description>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="^1.74.0" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value="other.dep" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionPack" Value="demo.pack-a" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="workspace" />
    </Properties>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code" />
  </Installation>
  <Dependencies />
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/readme.md" />
  </Assets>
</PackageManifest>
`;

export const defaultPackageJson = `{
  "name": "hello",
  "publisher": "demo",
  "version": "1.2.3",
  "engines": { "vscode": "^1.74.0" },
  "main": "./out/extension.js",
  "browser": "./out/web/extension.js",
  "activationEvents": ["onCommand:demo.hello", "*", "onStartupFinished"],
  "contributes": {
    "commands": [
      { "command": "demo.hello", "title": "Say Hello" },
      { "command": "demo.world", "title": "Say World" }
    ],
    "configuration": { "title": "Hello" }
  },
  "extensionDependencies": ["other.dep"],
  "extensionPack": ["demo.pack-a"],
  "extensionKind": ["workspace"],
  "capabilities": {
    "untrustedWorkspaces": { "supported": true, "description": "No workspace trust needed." },
    "virtualWorkspaces": { "supported": "limited", "description": "Read-only on virtual FS." }
  },
  "enabledApiProposals": ["testObserver"]
}
`;

const addText = async (
  writer: ZipWriter<Uint8Array>,
  name: string,
  text: string,
): Promise<void> => {
  await writer.add(name, new TextReader(text), { level: 0 });
};

const addBytes = async (
  writer: ZipWriter<Uint8Array>,
  name: string,
  bytes: Uint8Array,
): Promise<void> => {
  await writer.add(name, new Uint8ArrayReader(bytes), { level: 0 });
};

/** Inert OPC ZIP with a vsixmanifest, package.json, and conventional members. */
export const vsixPackageFixture = async (
  options: {
    readonly vsixmanifest?: string;
    readonly packageJson?: string | null;
    readonly extraMembers?: Readonly<Record<string, string>>;
    readonly extraBinaryMembers?: Readonly<Record<string, Uint8Array>>;
    readonly includeContentTypes?: boolean;
    readonly includeManifest?: boolean;
    readonly includeMain?: boolean;
    readonly includeBrowser?: boolean;
    readonly includeSignature?: boolean;
  } = {},
): Promise<Uint8Array> => {
  const writer = new ZipWriter(new Uint8ArrayWriter());
  if (options.includeContentTypes !== false)
    await addText(writer, "[Content_Types].xml", CONTENT_TYPES);
  if (options.includeManifest !== false)
    await addText(
      writer,
      "extension.vsixmanifest",
      options.vsixmanifest ?? defaultVsixManifest,
    );
  if (options.packageJson !== null)
    await addText(
      writer,
      "extension/package.json",
      options.packageJson ?? defaultPackageJson,
    );
  if (options.includeMain !== false)
    await addText(
      writer,
      "extension/out/extension.js",
      "exports.activate = () => {};",
    );
  if (options.includeBrowser !== false)
    await addText(
      writer,
      "extension/out/web/extension.js",
      "exports.activate = () => {};",
    );
  await addText(writer, "extension/readme.md", "Hello demo.");
  if (options.includeSignature === true) {
    await addBytes(
      writer,
      "extension.signature.p7s",
      Uint8Array.from([0x30, 0x80, 0x06, 0x09]),
    );
    await addText(writer, ".signature.manifest", '{"package":"unsigned"}');
  }
  for (const [name, text] of Object.entries(options.extraMembers ?? {}))
    await addText(writer, name, text);
  for (const [name, bytes] of Object.entries(options.extraBinaryMembers ?? {}))
    await addBytes(writer, name, bytes);
  return writer.close();
};

/** ZIP that is a valid archive but has no vsixmanifest. */
export const vsixPackageMissingManifestFixture =
  async (): Promise<Uint8Array> =>
    vsixPackageFixture({ includeManifest: false });

/** ZIP whose vsixmanifest is not well-formed XML. */
export const vsixPackageMalformedManifestFixture =
  async (): Promise<Uint8Array> =>
    vsixPackageFixture({
      vsixmanifest: "<PackageManifest><Metadata><Identity Id='broken'",
    });

/** ZIP whose package.json is not well-formed JSON. */
export const vsixPackageMalformedPackageJsonFixture =
  async (): Promise<Uint8Array> =>
    vsixPackageFixture({ packageJson: '{ "name": "broken",' });

/** ZIP with a path-traversal member name. */
export const vsixPackageTraversalFixture = async (): Promise<Uint8Array> =>
  vsixPackageFixture({
    extraMembers: { "../outside.js": "exports.x = 1;" },
  });
