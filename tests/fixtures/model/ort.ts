/** Synthetic ORT declarations encoded from the public ort.fbs schema.
 * This independent forward writer deliberately puts vtables after tables,
 * exercising legal negative signed vtable displacements. No runtime or model
 * payload is executed, and these fixtures do not claim producer provenance.
 */
type Field = string | number | bigint | (() => number) | undefined;
class Writer {
  readonly bytes = Buffer.alloc(65536);
  position = 8;
  readonly fields = new Map<string, number>();

  align(width: number): void {
    this.position = Math.ceil(this.position / width) * width;
  }

  text(value: string): number {
    this.align(4);
    const at = this.position;
    const length = this.bytes.write(value, at + 4, "utf8");
    this.bytes.writeUInt32LE(length, at);
    this.position += 4 + length + 1;
    return at;
  }

  vector(values: readonly (() => number)[]): number {
    this.align(4);
    const at = this.position;
    this.bytes.writeUInt32LE(values.length, at);
    this.position += 4 + values.length * 4;
    for (const [index, value] of values.entries()) {
      const field = at + 4 + index * 4;
      this.bytes.writeUInt32LE(value() - field, field);
    }
    return at;
  }

  integers(values: readonly bigint[]): number {
    this.align(8);
    this.position += 4;
    const at = this.position;
    this.bytes.writeUInt32LE(values.length, at);
    this.position += 4;
    for (const value of values) {
      this.bytes.writeBigInt64LE(value, this.position);
      this.position += 8;
    }
    return at;
  }

  raw(length: number): number {
    this.align(4);
    const at = this.position;
    this.bytes.writeUInt32LE(length, at);
    this.bytes.fill(0xa5, at + 4, at + 4 + length);
    this.position += 4 + length;
    return at;
  }

  table(fields: readonly Field[], label?: string): number {
    this.align(8);
    const at = this.position;
    const size = 8 + fields.length * 8;
    const vtable = at + size;
    this.bytes.writeInt32LE(at - vtable, at);
    this.bytes.writeUInt16LE(4 + fields.length * 2, vtable);
    this.bytes.writeUInt16LE(size, vtable + 2);
    this.position = vtable + 4 + fields.length * 2;
    for (const [index, value] of fields.entries()) {
      if (value === undefined) continue;
      const field = at + 8 + index * 8;
      this.bytes.writeUInt16LE(8 + index * 8, vtable + 4 + index * 2);
      if (label !== undefined)
        this.fields.set(`${label}.${String(index)}`, field);
      if (typeof value === "number") this.bytes.writeInt32LE(value, field);
      else if (typeof value === "bigint")
        this.bytes.writeBigInt64LE(value, field);
      else
        this.bytes.writeUInt32LE(
          (typeof value === "string" ? this.text(value) : value()) - field,
          field,
        );
    }
    return at;
  }
}

export interface OrtFixtureOptions {
  version?: string;
  inputShape?: readonly (string | bigint | null)[] | null;
  inputType?: number;
  inputKind?: number;
  missingInput?: boolean;
  tensorType?: number;
  tensorBytes?: number;
  externalOffset?: bigint;
  stringTensor?: boolean;
  sparseInitializer?: boolean;
  missingOperatorVersion?: boolean;
}

export const ortFixture = (options: OrtFixtureOptions = {}) => {
  const writer = new Writer();
  const dimension = (value: string | bigint | null) => () =>
    writer.table([
      () =>
        writer.table([
          value === null ? 0 : typeof value === "string" ? 2 : 1,
          typeof value === "bigint" && value !== 0n ? value : undefined,
          typeof value === "string" ? value : undefined,
        ]),
    ]);
  const shape =
    options.inputShape === undefined
      ? ["batch", 3n, "height", "width"]
      : options.inputShape;
  const valueInfo =
    (
      name: string,
      dimensions: readonly (string | bigint | null)[] | null,
      type: number,
    ) =>
    () =>
      writer.table([
        name,
        undefined,
        () =>
          writer.table([
            undefined,
            options.inputKind ?? 1,
            () =>
              writer.table([
                type,
                dimensions === null
                  ? undefined
                  : () =>
                      writer.table([
                        () => writer.vector(dimensions.map(dimension)),
                      ]),
              ]),
          ]),
      ]);
  const tensor = () =>
    writer.table(
      [
        "weight",
        undefined,
        () => writer.integers([2n, 2n]),
        options.stringTensor ? 8 : (options.tensorType ?? 1),
        options.externalOffset === undefined && !options.stringTensor
          ? () => writer.raw(options.tensorBytes ?? 16)
          : undefined,
        options.stringTensor
          ? () =>
              writer.vector(
                ["a", "b", "c", "d"].map((text) => () => writer.text(text)),
              )
          : undefined,
        options.externalOffset,
      ],
      "tensor",
    );
  const graph = () =>
    writer.table(
      [
        () => writer.vector([tensor]),
        () =>
          writer.vector([
            ...(options.missingInput
              ? []
              : [valueInfo("images", shape, options.inputType ?? 1)]),
            valueInfo("result", ["batch", 3n, "height", "width"], 1),
          ]),
        () =>
          writer.vector([
            () =>
              writer.table(
                [
                  "conv",
                  undefined,
                  "",
                  options.missingOperatorVersion ? undefined : 10,
                  0,
                  "ConvInteger",
                ],
                "node0",
              ),
            () =>
              writer.table(
                ["activation", undefined, "com.microsoft", 1, 1, "QuickGelu"],
                "node1",
              ),
          ]),
        2,
        undefined,
        () => writer.vector([() => writer.text("images")]),
        () => writer.vector([() => writer.text("result")]),
        options.sparseInitializer
          ? () => writer.vector([() => writer.table([])])
          : undefined,
      ],
      "graph",
    );
  const root = writer.table(
    [
      options.version ?? "6",
      () =>
        writer.table([
          9n,
          undefined,
          "REA synthetic fixture",
          undefined,
          undefined,
          undefined,
          undefined,
          graph,
        ]),
    ],
    "session",
  );
  writer.bytes.writeUInt32LE(root, 0);
  writer.bytes.write("ORTM", 4, "ascii");
  return {
    bytes: writer.bytes.subarray(0, writer.position),
    fields: writer.fields,
  };
};
