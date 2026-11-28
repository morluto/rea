/** A literal-only LZ4 block is one sequence because separate sequences require a match. */
export const lz4LiteralBlock = (data: Buffer): Buffer => {
  const head = [Math.min(data.length, 15) << 4];
  if (data.length >= 15) {
    let extra = data.length - 15;
    while (extra >= 255) {
      head.push(255);
      extra -= 255;
    }
    head.push(extra);
  }
  return Buffer.concat([Buffer.from(head), data]);
};
