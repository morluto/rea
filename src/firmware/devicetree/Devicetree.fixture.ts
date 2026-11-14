/** Small synthetic DTB writer shared by parser and public workflow tests. */
export interface FixtureNode {
  name: string;
  properties?: Record<string, Buffer>;
  children?: FixtureNode[];
}
export const cells = (...values: number[]): Buffer => {
  const b = Buffer.alloc(values.length * 4);
  values.forEach((v, i) => b.writeUInt32BE(v, i * 4));
  return b;
};
export const dtString = (value: string): Buffer => Buffer.from(`${value}\0`);
export const devicetreeFixture = (
  root: FixtureNode = {
    name: "",
    properties: {
      compatible: dtString("test,board"),
      model: dtString("Test board"),
      "#address-cells": cells(1),
      "#size-cells": cells(1),
    },
    children: [
      {
        name: "chosen",
        properties: {
          bootargs: dtString("console=ttyS0"),
          "stdout-path": dtString("serial0"),
        },
      },
      { name: "aliases", properties: { serial0: dtString("/serial@1000") } },
      {
        name: "serial@1000",
        properties: {
          reg: cells(0x1000, 0x100),
          phandle: cells(1),
          "interrupt-parent": cells(99),
        },
      },
      { name: "consumer", properties: { "remote-endpoint": cells(1) } },
    ],
  },
  version = 17,
): Buffer => {
  const names = new Map<string, number>(),
    strings: Buffer[] = [],
    structure: Buffer[] = [];
  let stringBytes = 0;
  const padded = (b: Buffer) =>
    Buffer.concat([b, Buffer.alloc((4 - (b.length % 4)) % 4)]);
  const walk = (node: FixtureNode) => {
    structure.push(cells(1), padded(dtString(node.name)));
    for (const [name, value] of Object.entries(node.properties ?? {})) {
      let offset = names.get(name);
      if (offset === undefined) {
        offset = stringBytes;
        names.set(name, offset);
        const b = dtString(name);
        strings.push(b);
        stringBytes += b.length;
      }
      structure.push(cells(3, value.length, offset), padded(value));
    }
    node.children?.forEach(walk);
    structure.push(cells(2));
  };
  walk(root);
  structure.push(cells(9));
  const body = Buffer.concat(structure),
    namesBlock = Buffer.concat(strings);
  const header = cells(
    0xd00dfeed,
    72 + body.length + namesBlock.length,
    72,
    72 + body.length,
    40,
    version,
    16,
    0,
    namesBlock.length,
    body.length,
  );
  const reservations = Buffer.alloc(32);
  reservations.writeBigUInt64BE(0x80000000n, 0);
  reservations.writeBigUInt64BE(0x1000n, 8);
  return Buffer.concat([header, reservations, body, namesBlock]);
};

/** Minimal valid FDT whose empty strings range starts at the reservation map. */
export const emptyStringsAtReservationBoundaryFixture = (
  version: 16 | 17,
): Buffer => {
  const bytes = Buffer.alloc(72);
  const write = (offset: number, value: number) =>
    bytes.writeUInt32BE(value, offset);
  write(0, 0xd00dfeed);
  write(4, bytes.length);
  write(8, 40);
  write(12, 56);
  write(16, 56);
  write(20, version);
  write(24, 16);
  write(32, 0);
  if (version === 17) write(36, 16);
  write(40, 1);
  write(44, 0);
  write(48, 2);
  write(52, 9);
  return bytes;
};
