import type { Element } from "@xmldom/xmldom";

import {
  MACOS_PKG_FORMAT,
  type MacosPkgParseError,
} from "../../domain/macosPkgFormat.js";
import { malformedInput } from "../../domain/parseFailure.js";
import { err, ok, type Result } from "../../domain/result.js";
import { decodeStrictUtf8 } from "../../domain/strictUtf8.js";
import { parseXmlDocument } from "../../domain/xmlDocument.js";
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

const parseUtf8Xml = (
  bytes: Buffer,
  rootName: string,
  rootElement: string,
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
  const document = parseXmlDocument(text, {
    doctype: "reject",
    lineEndings: "preserve",
  });
  if (!document.ok)
    return err(
      malformedInput(MACOS_PKG_FORMAT, document.error.failure.detail, {
        field: rootName,
        cause: document.error,
      }),
    );
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

const collectChoices = (element: Element, choices: string[]): void => {
  const choice = attributeOf(element, "choice");
  if (choice !== null) choices.push(choice);
  for (const child of childElements(element, "line"))
    collectChoices(child, choices);
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
): Result<DistributionFacts, MacosPkgParseError> => {
  const root = parseUtf8Xml(bytes, "Distribution", "installer-gui-script");
  if (!root.ok) return root;
  const installer = root.value;
  const title = childElement(installer, "title")?.textContent ?? null;
  const pkgRefs = childElements(installer, "pkg-ref").map((element) => ({
    id: attributeOf(element, "id"),
    version: attributeOf(element, "version"),
    installKBytes: uint32Attribute(element, "installKBytes"),
  }));
  const choices: string[] = [];
  const outline = childElement(installer, "choices-outline");
  if (outline !== undefined) collectChoices(outline, choices);
  const allowedOsVersions = childElements(
    childElement(installer, "allowed-os-versions") ?? installer,
    "os-version",
  ).map((element) => ({
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
): Result<PackageInfoFacts, MacosPkgParseError> => {
  const root = parseUtf8Xml(bytes, "PackageInfo", "pkg-info");
  if (!root.ok) return root;
  const info = root.value;
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
    bundles: childElements(info, "bundle").map((element) => ({
      id: attributeOf(element, "id"),
      path: attributeOf(element, "path"),
      cfBundleIdentifier: attributeOf(element, "CFBundleIdentifier"),
      cfBundleVersion: attributeOf(element, "CFBundleVersion"),
    })),
    preinstall: scriptFile("preinstall"),
    postinstall: scriptFile("postinstall"),
  });
};
