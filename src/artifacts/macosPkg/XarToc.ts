import { X509Certificate } from "node:crypto";
import type { Document, Element } from "@xmldom/xmldom";

import {
  MACOS_PKG_FORMAT,
  MACOS_PKG_MAX_TOC_FILES,
  macosPkgLimitFailure,
  type MacosPkgParseError,
} from "../../domain/macosPkgFormat.js";
import { malformedInput, truncatedInput } from "../../domain/parseFailure.js";
import { err, ok, type Result } from "../../domain/result.js";
import { parseXmlDocument } from "../../domain/xmlDocument.js";
import { decodeStrictUtf8 } from "../../domain/strictUtf8.js";
import { childElement, childElements, childText } from "./xmlElements.js";

export interface XarChecksumRecord {
  readonly algorithm: string;
  readonly value: string;
}

export interface XarFileData {
  readonly offset: number;
  readonly length: number;
  readonly size: number;
  readonly encoding: string;
  readonly archivedChecksum: XarChecksumRecord | null;
  readonly extractedChecksum: XarChecksumRecord | null;
}

export interface XarTocFile {
  readonly id: string | null;
  readonly path: string;
  readonly type: string;
  /** Octal `<mode>` as a uint32, or null when absent, malformed or out of range. */
  readonly mode: number | null;
  readonly data: XarFileData | null;
  readonly link: string | null;
}

export interface XarCertificateNames {
  readonly subjectCn: string | null;
  readonly issuerCn: string | null;
}

export interface XarTocSignature {
  readonly kind: "signature" | "x-signature";
  readonly algorithm: string | null;
  readonly certificates: readonly XarCertificateNames[];
}

export interface XarToc {
  readonly files: readonly XarTocFile[];
  readonly signatures: readonly XarTocSignature[];
}

const UINT32_MAX = 0xffffffff;

/** Read `<mode>` octal text once; anything that is not a uint32 stays unknown. */
const parseMode = (text: string | undefined): number | null => {
  const trimmed = text?.trim();
  if (trimmed === undefined || !/^[0-7]+$/u.test(trimmed)) return null;
  const value = Number.parseInt(trimmed, 8);
  return value <= UINT32_MAX ? value : null;
};

const nonNegativeInteger = (
  text: string | undefined,
  field: string,
): Result<number, MacosPkgParseError> => {
  if (text === undefined)
    return err(
      malformedInput(MACOS_PKG_FORMAT, `XAR TOC omits <${field}>`, { field }),
    );
  const trimmed = text.trim();
  if (!/^[0-9]+$/u.test(trimmed))
    return err(
      malformedInput(
        MACOS_PKG_FORMAT,
        `XAR TOC <${field}> is not a decimal integer`,
        { field },
      ),
    );
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value))
    return err(
      malformedInput(
        MACOS_PKG_FORMAT,
        `XAR TOC <${field}> is not an exact nonnegative extent`,
        { field },
      ),
    );
  return ok(value);
};

const parseChecksum = (
  parent: Element,
  tag: string,
): XarChecksumRecord | null => {
  const element = childElement(parent, tag);
  if (element === undefined) return null;
  const algorithm = (element.getAttribute("style") ?? "").trim().toLowerCase();
  const value = (element.textContent ?? "").trim().toLowerCase();
  if (algorithm === "" && value === "") return null;
  return { algorithm: algorithm === "" ? "unknown" : algorithm, value };
};

const parseData = (
  file: Element,
): Result<XarFileData | null, MacosPkgParseError> => {
  const data = childElement(file, "data");
  if (data === undefined) return ok(null);
  const offset = nonNegativeInteger(childText(data, "offset"), "offset");
  if (!offset.ok) return offset;
  const length = nonNegativeInteger(childText(data, "length"), "length");
  if (!length.ok) return length;
  const size = nonNegativeInteger(childText(data, "size"), "size");
  if (!size.ok) return size;
  const encoding =
    childElement(data, "encoding")?.getAttribute("style")?.trim() ||
    "application/octet-stream";
  return ok({
    offset: offset.value,
    length: length.value,
    size: size.value,
    encoding,
    archivedChecksum: parseChecksum(data, "archived-checksum"),
    extractedChecksum: parseChecksum(data, "extracted-checksum"),
  });
};

const commonName = (distinguishedName: string): string | null => {
  for (const line of distinguishedName.split(/\n/u)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("CN=")) return trimmed.slice(3) || null;
  }
  const match = /(?:^|,)\s*CN\s*=\s*([^,]+)/u.exec(distinguishedName);
  return match?.[1]?.trim() || null;
};

const parseCertificates = (parent: Element): XarCertificateNames[] => {
  const certs: XarCertificateNames[] = [];
  const walk = (node: Element): void => {
    if (node.tagName === "X509Certificate") {
      const text = (node.textContent ?? "").replace(/\s+/gu, "");
      try {
        const cert = new X509Certificate(Buffer.from(text, "base64"));
        certs.push({
          subjectCn: commonName(cert.subject),
          issuerCn: commonName(cert.issuer),
        });
      } catch {
        certs.push({ subjectCn: null, issuerCn: null });
      }
      return;
    }
    for (const child of childElements(node)) walk(child);
  };
  for (const child of childElements(parent)) walk(child);
  return certs;
};

const parseSignature = (
  toc: Element,
  tag: "signature" | "x-signature",
): XarTocSignature | null => {
  const element = childElement(toc, tag);
  if (element === undefined) return null;
  const algorithm = element.getAttribute("style")?.trim() || null;
  return {
    kind: tag,
    algorithm,
    certificates: parseCertificates(element),
  };
};

const unsafeName = (name: string): boolean =>
  name.length === 0 ||
  name === "." ||
  name === ".." ||
  name.includes("\0") ||
  name.includes("/") ||
  name.includes("\\");

const walkFiles = (
  parent: Element,
  prefix: string,
  files: XarTocFile[],
): Result<void, MacosPkgParseError> => {
  for (const file of childElements(parent, "file")) {
    if (files.length >= MACOS_PKG_MAX_TOC_FILES)
      return err(
        macosPkgLimitFailure(
          `XAR TOC declares more than ${String(MACOS_PKG_MAX_TOC_FILES)} files`,
          {
            name: "macos_pkg_toc_files",
            maximum: MACOS_PKG_MAX_TOC_FILES,
            required: files.length + 1,
          },
          "file",
        ),
      );
    const names = childElements(file, "name").map(
      (element) => element.textContent ?? "",
    );
    if (names.length === 0)
      return err(
        malformedInput(MACOS_PKG_FORMAT, "XAR TOC <file> omits <name>", {
          field: "name",
        }),
      );
    if (names.some((name) => name !== names[0]))
      return err(
        malformedInput(
          MACOS_PKG_FORMAT,
          "XAR TOC <file> has conflicting <name> declarations",
          { field: "name" },
        ),
      );
    const name = names[0] ?? "";
    if (unsafeName(name))
      return err(
        malformedInput(
          MACOS_PKG_FORMAT,
          `XAR TOC file name is not a single relative path component: ${name}`,
          { field: "name" },
        ),
      );
    const path = prefix === "" ? name : `${prefix}/${name}`;
    const type = (childText(file, "type") ?? "file").trim() || "file";
    const data = parseData(file);
    if (!data.ok) return data;
    files.push({
      id: file.getAttribute("id") || null,
      path,
      type,
      mode: parseMode(childText(file, "mode")),
      data: data.value,
      link: childText(file, "link") ?? null,
    });
    const nested = walkFiles(file, path, files);
    if (!nested.ok) return nested;
  }
  return ok(undefined);
};

/** Decode zlib-uncompressed TOC XML into file records and signature declarations. */
export const parseXarTocXml = (
  xmlBytes: Buffer,
): Result<XarToc, MacosPkgParseError> => {
  let text: string;
  try {
    text = decodeStrictUtf8(xmlBytes, "strip-signature");
  } catch (cause: unknown) {
    return err(
      malformedInput(MACOS_PKG_FORMAT, "XAR TOC XML is not UTF-8", {
        field: "toc",
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
        field: "toc",
        cause: document.error,
      }),
    );
  return parseXarTocDocument(document.value);
};

const parseXarTocDocument = (
  document: Document,
): Result<XarToc, MacosPkgParseError> => {
  const root = document.documentElement;
  if (root === null || root.tagName !== "xar")
    return err(
      malformedInput(MACOS_PKG_FORMAT, "XAR TOC root is not <xar>", {
        field: "toc",
      }),
    );
  const toc = childElement(root, "toc");
  if (toc === undefined)
    return err(
      malformedInput(MACOS_PKG_FORMAT, "XAR TOC omits <toc>", { field: "toc" }),
    );
  const files: XarTocFile[] = [];
  const walked = walkFiles(toc, "", files);
  if (!walked.ok) return walked;
  const signatures = [
    parseSignature(toc, "signature"),
    parseSignature(toc, "x-signature"),
  ].filter((record): record is XarTocSignature => record !== null);
  return ok({ files, signatures });
};

export const heapRangeRefusal = (
  file: XarTocFile,
  heapLength: number,
): MacosPkgParseError | undefined => {
  const data = file.data;
  if (data === null) return undefined;
  if (
    !Number.isSafeInteger(data.offset) ||
    !Number.isSafeInteger(data.length) ||
    data.offset < 0 ||
    data.length < 0 ||
    data.offset + data.length > heapLength
  )
    return truncatedInput(
      MACOS_PKG_FORMAT,
      `XAR file ${file.path} heap range ${String(data.offset)}+${String(data.length)} exceeds the ${String(heapLength)}-byte heap`,
      { field: "data" },
    );
  return undefined;
};
