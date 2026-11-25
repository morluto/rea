import { visit } from "jsonc-parser";
import { isInteger } from "lossless-json";

type Parent = {
  readonly value: unknown[] | Record<string, unknown>;
  readonly commandOutput: boolean;
};

/** Decode authenticated JSON-mode command replies with exact output integers. */
export const parseCutterCommandResponse = (text: string): unknown => {
  // Integers outside the safe range need at least 16 digits. Keep ordinary
  // replies on the native path and avoid a source reviver's per-node storage
  // when a large output does contain an unsafe integer.
  if (!/\d{16}/u.test(text)) return JSON.parse(text) as unknown;

  const parents: Parent[] = [];
  let result: unknown;
  let key = "";
  const inCommandOutput = (): boolean =>
    parents.at(-1)?.commandOutput === true ||
    (parents.length === 1 && key === "output");
  const append = (value: unknown): void => {
    const parent = parents.at(-1)?.value;
    if (parent === undefined) result = value;
    else if (Array.isArray(parent)) parent.push(value);
    else if (key === "__proto__")
      Object.defineProperty(parent, key, {
        value,
        writable: true,
        enumerable: true,
        configurable: true,
      });
    else parent[key] = value;
  };
  const begin = (value: Parent["value"]): void => {
    const commandOutput = inCommandOutput();
    append(value);
    parents.push({ value, commandOutput });
  };
  visit(
    text,
    {
      onObjectBegin: () => begin({}),
      onObjectProperty: (name) => {
        key = name;
      },
      onObjectEnd: () => {
        parents.pop();
      },
      onArrayBegin: () => begin([]),
      onArrayEnd: () => {
        parents.pop();
      },
      onLiteralValue: (value: unknown, offset, length) => {
        if (
          typeof value === "number" &&
          !Number.isSafeInteger(value) &&
          inCommandOutput()
        ) {
          const source = text.slice(offset, offset + length);
          if (isInteger(source)) {
            append(source);
            return;
          }
        }
        append(value);
      },
      onError: () => {
        throw new SyntaxError("Invalid Cutter command response JSON");
      },
    },
    { disallowComments: true },
  );
  return result;
};
