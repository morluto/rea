import type { Element } from "@xmldom/xmldom";

import {
  MACOS_PKG_FORMAT,
  MACOS_PKG_MAX_METADATA_RECORDS,
  MACOS_PKG_MAX_METADATA_XML_NODES,
  macosPkgLimitFailure,
  type MacosPkgParseError,
} from "../../domain/macosPkgFormat.js";
import {
  malformedInput,
  ParseFailureError,
} from "../../domain/parseFailure.js";
import { err, ok, type Result } from "../../domain/result.js";
import { decodeStrictUtf8 } from "../../domain/strictUtf8.js";
import { parseXmlDocumentWithinNodeLimit } from "../../domain/xmlDocument.js";
import { attributeOf, childElement, childElements } from "./xmlElements.js";

export interface PkgRefRecord {
  readonly id: string | null;
  readonly version: string | null;
  readonly installKBytes: number | null;
}

export interface OsVersionRange {
  readonly min: string | null;
  readonly max: string | null;
}

export interface DistributionFacts {
  readonly title: string | null;
  readonly pkgRefs: readonly PkgRefRecord[];
  readonly choices: readonly string[];
  readonly allowedOsVersions: readonly OsVersionRange[];
  readonly installationCheckScriptBytes: number | null;
  readonly volumeCheckScriptBytes: number | null;
}

export interface PackageBundleRecord {
  readonly id: string | null;
  readonly path: string | null;
  readonly cfBundleIdentifier: string | null;
  readonly cfBundleVersion: string | null;
}

export interface PackageInfoFacts {
  readonly identifier: string | null;
  readonly version: string | null;
  readonly installLocation: string | null;
  readonly auth: string | null;
  readonly postinstallAction: string | null;
  readonly bundles: readonly PackageBundleRecord[];
  readonly preinstall: string | null;
  readonly postinstall: string | null;
}

export interface InstallerXmlLimits {
  readonly remainingRecords: number;
  readonly maxRecords: number;
  readonly maxXmlNodes: number;
}

const resolveXmlLimits = (
  limits?: Partial<InstallerXmlLimits>,
): InstallerXmlLimits => {
  const maxRecords = Math.max(
    0,
    Math.floor(limits?.maxRecords ?? MACOS_PKG_MAX_METADATA_RECORDS),
  );
  const remainingRecords = Math.max(
    0,
    Math.min(maxRecords, Math.floor(limits?.remainingRecords ?? maxRecords)),
  );
  const maxXmlNodes = Math.max(
    0,
    Math.floor(limits?.maxXmlNodes ?? MACOS_PKG_MAX_METADATA_XML_NODES),
  );
  return { remainingRecords, maxRecords, maxXmlNodes };
};

const parseUtf8Xml = (
  bytes: Buffer,
  rootName: string,
  rootElement: string,
  maxXmlNodes: number = MACOS_PKG_MAX_METADATA_XML_NODES,
): Result<Element, MacosPkgParseError> => {
  let text: string;
  try {
    text = decodeStrictUtf8(bytes, "strip-signature");
  } catch (cause: unknown) {
    return err(
      malformedInput(MACOS_PKG_FORMAT, `${rootName} XML is not UTF-8`, {
        field: rootName,
        cause,
      }),
    );
  }
  const nodeLimit = Math.max(0, Math.floor(maxXmlNodes));
  // Count nodes while streaming so dense documents cannot build an unbounded DOM.
  const document = parseXmlDocumentWithinNodeLimit(text, {
    maximumNodes: nodeLimit,
    lineEndings: "preserve",
  });
  if (!document.ok) {
    const failure = document.error;
    return err(
      failure instanceof ParseFailureError
        ? malformedInput(MACOS_PKG_FORMAT, failure.failure.detail, {
            field: rootName,
            cause: failure,
          })
        : macosPkgLimitFailure(
            `${rootName} XML exceeds ${String(failure.maximum)} nodes; raise artifact_limits.expanded_bytes to admit larger installer metadata`,
            {
              name: "macos_pkg_metadata_xml_nodes",
              maximum: failure.maximum,
              required: failure.required,
            },
            rootName,
          ),
    );
  }
  const root = document.value.documentElement;
  if (root === null)
    return err(
      malformedInput(
        MACOS_PKG_FORMAT,
        `${rootName} XML has no document element`,
        {
          field: rootName,
        },
      ),
    );
  if (root.tagName !== rootElement)
    return err(
      malformedInput(
        MACOS_PKG_FORMAT,
        `${rootName} XML root is not <${rootElement}>`,
        { field: rootName },
      ),
    );
  return ok(root);
};

const UINT32_MAX = 0xffff_ffff;

/** Unsigned decimal attribute that fits the report's uint32 field, else unknown. */
const uint32Attribute = (element: Element, name: string): number | null => {
  const text = attributeOf(element, name);
  if (text === null || !/^[0-9]+$/u.test(text)) return null;
  const value = Number(text);
  return Number.isSafeInteger(value) && value <= UINT32_MAX ? value : null;
};

const metadataRecordLimitError = (
  rootName: "Distribution" | "PackageInfo",
  maxRecords: number,
  remainingRecords: number,
  requiredInDoc: number,
): MacosPkgParseError =>
  macosPkgLimitFailure(
    remainingRecords < maxRecords
      ? `${rootName} XML exceeds the ${String(maxRecords)}-record package installer metadata allowance; raise artifact_limits.expanded_bytes to admit more installer metadata`
      : `${rootName} XML declares more than ${String(maxRecords)} metadata records; raise artifact_limits.expanded_bytes to admit more installer metadata`,
    {
      name: "macos_pkg_metadata_records",
      maximum: maxRecords,
      required: maxRecords - remainingRecords + requiredInDoc,
    },
    rootName,
  );

const collectChoices = (
  element: Element,
  choices: string[],
  maxChoices: number,
): boolean => {
  const choice = attributeOf(element, "choice");
  if (choice !== null) {
    if (choices.length >= maxChoices) return false;
    choices.push(choice);
  }
  for (const child of childElements(element, "line"))
    if (!collectChoices(child, choices, maxChoices)) return false;
  return true;
};

const scriptLength = (parent: Element | undefined): number | null => {
  if (parent === undefined) return null;
  const script = childElement(parent, "script");
  const text = (script ?? parent).textContent ?? "";
  return Buffer.byteLength(text, "utf8");
};

/** Parse a product-archive `Distribution` document. JavaScript is length-only. */
export const parseDistributionXml = (
  bytes: Buffer,
  limits?: Partial<InstallerXmlLimits>,
): Result<DistributionFacts, MacosPkgParseError> => {
  const { remainingRecords, maxRecords, maxXmlNodes } =
    resolveXmlLimits(limits);
  const root = parseUtf8Xml(
    bytes,
    "Distribution",
    "installer-gui-script",
    maxXmlNodes,
  );
  if (!root.ok) return root;
  const installer = root.value;
  const title = childElement(installer, "title")?.textContent ?? null;
  const pkgRefElements = childElements(installer, "pkg-ref");
  if (pkgRefElements.length > remainingRecords)
    return err(
      metadataRecordLimitError(
        "Distribution",
        maxRecords,
        remainingRecords,
        pkgRefElements.length,
      ),
    );
  let retained = pkgRefElements.length;
  const choices: string[] = [];
  const outline = childElement(installer, "choices-outline");
  if (
    outline !== undefined &&
    !collectChoices(outline, choices, remainingRecords - retained)
  )
    return err(
      metadataRecordLimitError(
        "Distribution",
        maxRecords,
        remainingRecords,
        retained + choices.length + 1,
      ),
    );
  retained += choices.length;
  const osVersionElements = childElements(
    childElement(installer, "allowed-os-versions") ?? installer,
    "os-version",
  );
  if (retained + osVersionElements.length > remainingRecords)
    return err(
      metadataRecordLimitError(
        "Distribution",
        maxRecords,
        remainingRecords,
        retained + osVersionElements.length,
      ),
    );
  const pkgRefs = pkgRefElements.map((element) => ({
    id: attributeOf(element, "id"),
    version: attributeOf(element, "version"),
    installKBytes: uint32Attribute(element, "installKBytes"),
  }));
  const allowedOsVersions = osVersionElements.map((element) => ({
    min: attributeOf(element, "min"),
    max: attributeOf(element, "max"),
  }));
  return ok({
    title,
    pkgRefs,
    choices,
    allowedOsVersions,
    installationCheckScriptBytes: scriptLength(
      childElement(installer, "installation-check"),
    ),
    volumeCheckScriptBytes: scriptLength(
      childElement(installer, "volume-check"),
    ),
  });
};

/** Parse a component `PackageInfo` / `pkg-info` document. */
export const parsePackageInfoXml = (
  bytes: Buffer,
  limits?: Partial<InstallerXmlLimits>,
): Result<PackageInfoFacts, MacosPkgParseError> => {
  const { remainingRecords, maxRecords, maxXmlNodes } =
    resolveXmlLimits(limits);
  if (remainingRecords < 1)
    return err(
      metadataRecordLimitError("PackageInfo", maxRecords, remainingRecords, 1),
    );
  const root = parseUtf8Xml(bytes, "PackageInfo", "pkg-info", maxXmlNodes);
  if (!root.ok) return root;
  const info = root.value;
  const bundleElements = childElements(info, "bundle");
  const totalRecords = 1 + bundleElements.length;
  if (totalRecords > remainingRecords)
    return err(
      metadataRecordLimitError(
        "PackageInfo",
        maxRecords,
        remainingRecords,
        totalRecords,
      ),
    );
  const scripts = childElement(info, "scripts");
  const scriptFile = (tag: "preinstall" | "postinstall"): string | null => {
    const holder = scripts ?? info;
    const element = childElement(holder, tag);
    return element === undefined ? null : attributeOf(element, "file");
  };
  return ok({
    identifier: attributeOf(info, "identifier"),
    version: attributeOf(info, "version"),
    installLocation: attributeOf(info, "install-location"),
    auth: attributeOf(info, "auth"),
    postinstallAction: attributeOf(info, "postinstall-action"),
    bundles: bundleElements.map((element) => ({
      id: attributeOf(element, "id"),
      path: attributeOf(element, "path"),
      cfBundleIdentifier: attributeOf(element, "CFBundleIdentifier"),
      cfBundleVersion: attributeOf(element, "CFBundleVersion"),
    })),
    preinstall: scriptFile("preinstall"),
    postinstall: scriptFile("postinstall"),
  });
};
