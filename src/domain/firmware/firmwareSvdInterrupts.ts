import type { Element } from "@xmldom/xmldom";
import {
  decodeLimit,
  malformedInput,
  type ParseFailureError,
} from "../parseFailure.js";
import { err, ok, type Result } from "../result.js";
import {
  parseXmlDocumentWithinNodeLimit,
  xmlChildrenNamed,
  xmlFirstChildNamed,
} from "../xmlDocument.js";
import {
  DEFAULT_SVD_EXPANDED_CHARS,
  DEFAULT_SVD_XML_NODES,
} from "./firmwareVectorTable.js";

export interface SvdInterruptCandidate {
  readonly irqNumber: number;
  readonly interruptName: string;
  readonly peripheralName: string;
}

export interface SvdIrqLookupEntry {
  readonly irqNumber: number;
  readonly primaryName: string | null;
  readonly primaryPeripheral: string | null;
  readonly ambiguousNames: readonly string[];
  readonly expandedChars: number;
}

export interface ParseSvdInterruptOptions {
  readonly maxXmlNodes?: number;
  readonly maxExpandedChars?: number;
}

export type SvdInterruptParseError =
  | ParseFailureError<"malformed">
  | ParseFailureError<"unsupported">
  | ParseFailureError<"limit">;

const trimmedText = (element: Element | undefined): string | null => {
  if (element === undefined) return null;
  const text = (element.textContent ?? "").trim();
  return text.length > 0 ? `${text}` : null;
};

const parseNonNegativeInt = (raw: string): number | null => {
  const normalized = raw.trim();
  if (/^0x[0-9a-fA-F]+$/u.test(normalized)) {
    const parsed = Number.parseInt(normalized.slice(2), 16);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
  }
  if (/^[0-9]+$/u.test(normalized)) {
    const parsed = Number.parseInt(normalized, 10);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
  }
  return null;
};

interface IrqCandidateAccumulator {
  readonly items: SvdInterruptCandidate[];
  readonly seenKeys: Set<string>;
  expandedChars: number;
}

const candidateIdentityKey = (
  peripheralName: string,
  interruptName: string,
): string =>
  `${String(peripheralName.length)}:${peripheralName}:${interruptName}`;

/** Parse CMSIS-SVD `<peripheral><interrupt>` bindings without external DTDs. */
export const parseSvdInterruptMap = (
  svdXml: string,
  options?: ParseSvdInterruptOptions,
): Result<ReadonlyMap<number, SvdIrqLookupEntry>, SvdInterruptParseError> => {
  const maxXmlNodes = options?.maxXmlNodes ?? DEFAULT_SVD_XML_NODES;
  const maxExpandedChars =
    options?.maxExpandedChars ?? DEFAULT_SVD_EXPANDED_CHARS;

  const docResult = parseXmlDocumentWithinNodeLimit(svdXml, {
    maximumNodes: maxXmlNodes,
    lineEndings: "normalize",
  });
  if (!docResult.ok) {
    const failure = docResult.error;
    if ("kind" in failure && failure.kind === "node-limit") {
      return err(
        decodeLimit(
          "cmsis-svd",
          `svd_xml exceeded the ${String(failure.maximum)}-node XML ceiling`,
          { name: "max_svd_xml_nodes", maximum: failure.maximum },
        ),
      );
    }
    return err(failure);
  }

  const root = docResult.value.documentElement;
  if (root === null || root.localName !== "device") {
    return err(
      malformedInput("cmsis-svd", "CMSIS-SVD root element must be <device>."),
    );
  }

  const peripheralsEl = xmlFirstChildNamed(root, "peripherals");
  if (peripheralsEl === undefined) {
    return ok(new Map());
  }

  const rawByIrq = new Map<number, IrqCandidateAccumulator>();
  let totalExpandedChars = 0;

  for (const periphEl of xmlChildrenNamed(peripheralsEl, "peripheral")) {
    const periphName = trimmedText(xmlFirstChildNamed(periphEl, "name"));
    if (periphName === null) continue;
    for (const intEl of xmlChildrenNamed(periphEl, "interrupt")) {
      const intName = trimmedText(xmlFirstChildNamed(intEl, "name"));
      const valueText = trimmedText(xmlFirstChildNamed(intEl, "value"));
      if (intName === null || valueText === null) continue;
      const irqNumber = parseNonNegativeInt(valueText);
      if (irqNumber === null) continue;

      const key = candidateIdentityKey(periphName, intName);
      let acc = rawByIrq.get(irqNumber);
      if (acc?.seenKeys.has(key)) continue;

      const entryChars = periphName.length + 1 + intName.length;
      const nextExpandedChars = totalExpandedChars + entryChars;
      if (nextExpandedChars > maxExpandedChars) {
        return err(
          decodeLimit(
            "cmsis-svd",
            `CMSIS-SVD interrupt metadata expands beyond ${String(maxExpandedChars)} characters`,
            {
              name: "max_svd_expanded_chars",
              maximum: maxExpandedChars,
              required: nextExpandedChars,
            },
          ),
        );
      }
      totalExpandedChars = nextExpandedChars;

      if (acc === undefined) {
        acc = {
          items: [
            {
              irqNumber,
              interruptName: intName,
              peripheralName: periphName,
            },
          ],
          seenKeys: new Set([key]),
          expandedChars: entryChars,
        };
        rawByIrq.set(irqNumber, acc);
      } else {
        acc.seenKeys.add(key);
        acc.items.push({
          irqNumber,
          interruptName: intName,
          peripheralName: periphName,
        });
        acc.expandedChars += entryChars;
      }
    }
  }

  const lookup = new Map<number, SvdIrqLookupEntry>();
  for (const [irqNumber, acc] of rawByIrq.entries()) {
    if (acc.items.length === 1) {
      const only = acc.items[0]!;
      lookup.set(irqNumber, {
        irqNumber,
        primaryName: only.interruptName,
        primaryPeripheral: only.peripheralName,
        ambiguousNames: [],
        expandedChars: only.peripheralName.length + only.interruptName.length,
      });
    } else {
      lookup.set(irqNumber, {
        irqNumber,
        primaryName: null,
        primaryPeripheral: null,
        ambiguousNames: acc.items.map(
          (c) => `${c.peripheralName}:${c.interruptName}`,
        ),
        expandedChars: acc.expandedChars,
      });
    }
  }
  return ok(lookup);
};
