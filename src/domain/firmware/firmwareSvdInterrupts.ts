import type { Element } from "@xmldom/xmldom";
import { Budget } from "../budget.js";
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
}

/** IRQ bindings declared by a CMSIS-SVD document, and the declarations that could not be bound. */
export interface SvdInterruptMap {
  readonly byIrq: ReadonlyMap<number, SvdIrqLookupEntry>;
  /** One message per `<interrupt>` or `<peripheral>` skipped for a missing or invalid field. */
  readonly skipped: readonly string[];
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

/**
 * An `<interrupt><value>`: CMSIS-SVD declares it `xs:integer`, so decimal with
 * an optional `+`. Hexadecimal `0x`/`0X` is also accepted because vendor files
 * use it. A negative or other value is not an IRQ number.
 */
const HEX_IRQ_VALUE = /^0[xX][0-9a-fA-F]+$/u;
const DECIMAL_IRQ_VALUE = /^\+?[0-9]+$/u;

const parseIrqNumber = (raw: string): number | null => {
  const normalized = raw.trim();
  const parsed = HEX_IRQ_VALUE.test(normalized)
    ? Number.parseInt(normalized.slice(2), 16)
    : DECIMAL_IRQ_VALUE.test(normalized)
      ? Number.parseInt(normalized, 10)
      : Number.NaN;
  return Number.isSafeInteger(parsed) ? parsed : null;
};

interface IrqCandidateAccumulator {
  readonly items: SvdInterruptCandidate[];
}

/** Parse CMSIS-SVD `<peripheral><interrupt>` bindings without external DTDs. */
export const parseSvdInterruptMap = (
  svdXml: string,
  options?: ParseSvdInterruptOptions,
): Result<SvdInterruptMap, SvdInterruptParseError> => {
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
  const skipped: string[] = [];
  if (peripheralsEl === undefined) {
    return ok({ byIrq: new Map(), skipped });
  }

  const rawByIrq = new Map<number, IrqCandidateAccumulator>();
  // Interrupt names already bound, per peripheral name and IRQ. A peripheral
  // name is looked up once per <peripheral>, not once per <interrupt>, so a
  // long name repeated by many duplicate declarations costs work linear in
  // the document rather than name length times declaration count.
  const boundByPeripheral = new Map<string, Map<number, Set<string>>>();
  const expandedBudget = new Budget(maxExpandedChars);

  const chargeExpandedChars = (
    chars: number,
  ): SvdInterruptParseError | null => {
    const required = expandedBudget.used + chars;
    if (!expandedBudget.tryCharge(chars)) {
      return decodeLimit(
        "cmsis-svd",
        `CMSIS-SVD interrupt metadata expands beyond ${String(maxExpandedChars)} characters`,
        {
          name: "max_svd_expanded_chars",
          maximum: maxExpandedChars,
          required,
        },
      );
    }
    return null;
  };

  const appendSkipped = (
    parts: readonly string[],
  ): SvdInterruptParseError | null => {
    let messageChars = 0;
    for (const part of parts) messageChars += part.length;
    const limitError = chargeExpandedChars(messageChars);
    if (limitError !== null) return limitError;
    skipped.push(parts.join(""));
    return null;
  };

  for (const [periphIndex, periphEl] of xmlChildrenNamed(
    peripheralsEl,
    "peripheral",
  ).entries()) {
    const periphName = trimmedText(xmlFirstChildNamed(periphEl, "name"));
    const interrupts = xmlChildrenNamed(periphEl, "interrupt");
    if (periphName === null) {
      if (interrupts.length > 0) {
        const skippedError = appendSkipped([
          "CMSIS-SVD peripheral ",
          String(periphIndex),
          " has no <name>; its ",
          String(interrupts.length),
          " interrupt declaration(s) were not bound.",
        ]);
        if (skippedError !== null) return err(skippedError);
      }
      continue;
    }
    let boundByIrq = boundByPeripheral.get(periphName);
    if (boundByIrq === undefined) {
      boundByIrq = new Map();
      boundByPeripheral.set(periphName, boundByIrq);
    }
    for (const intEl of interrupts) {
      const intName = trimmedText(xmlFirstChildNamed(intEl, "name"));
      const valueText = trimmedText(xmlFirstChildNamed(intEl, "value"));
      const irqNumber = valueText === null ? null : parseIrqNumber(valueText);
      if (intName === null) {
        const skippedError =
          valueText === null
            ? appendSkipped([
                "CMSIS-SVD interrupt of peripheral ",
                periphName,
                " has no <name> and no <value>; it was not bound.",
              ])
            : irqNumber === null
              ? appendSkipped([
                  "CMSIS-SVD interrupt of peripheral ",
                  periphName,
                  ' has no <name> and value "',
                  valueText,
                  '", which is not a non-negative integer; it was not bound.',
                ])
              : appendSkipped([
                  'CMSIS-SVD interrupt with <value> "',
                  valueText,
                  '" of peripheral ',
                  periphName,
                  " has no <name>; it was not bound.",
                ]);
        if (skippedError !== null) return err(skippedError);
        continue;
      }
      if (irqNumber === null) {
        const skippedError =
          valueText === null
            ? appendSkipped([
                "CMSIS-SVD interrupt ",
                intName,
                " of peripheral ",
                periphName,
                " has no <value>; it was not bound.",
              ])
            : appendSkipped([
                "CMSIS-SVD interrupt ",
                intName,
                " of peripheral ",
                periphName,
                ' has value "',
                valueText,
                '", which is not a non-negative integer; it was not bound.',
              ]);
        if (skippedError !== null) return err(skippedError);
        continue;
      }

      let boundNames = boundByIrq.get(irqNumber);
      if (boundNames?.has(intName) === true) continue;

      // The `peripheral:interrupt` text an ambiguous binding reports; a
      // single binding reports less, so this bounds every emitted name.
      const entryChars = periphName.length + 1 + intName.length;
      const limitError = chargeExpandedChars(entryChars);
      if (limitError !== null) return err(limitError);

      if (boundNames === undefined) {
        boundNames = new Set();
        boundByIrq.set(irqNumber, boundNames);
      }
      boundNames.add(intName);
      let acc = rawByIrq.get(irqNumber);
      if (acc === undefined) {
        acc = {
          items: [
            {
              irqNumber,
              interruptName: intName,
              peripheralName: periphName,
            },
          ],
        };
        rawByIrq.set(irqNumber, acc);
      } else {
        acc.items.push({
          irqNumber,
          interruptName: intName,
          peripheralName: periphName,
        });
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
      });
    } else {
      lookup.set(irqNumber, {
        irqNumber,
        primaryName: null,
        primaryPeripheral: null,
        ambiguousNames: acc.items.map(
          (c) => `${c.peripheralName}:${c.interruptName}`,
        ),
      });
    }
  }
  return ok({ byIrq: lookup, skipped });
};
