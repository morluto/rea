// Source-owned shipped artifact for the reconstruction recipe; no dependencies.
const [command, ...operands] = process.argv.slice(2);
if (
  command !== "sum" ||
  operands.length !== 2 ||
  operands.some((operand) => !/^-?\d+$/u.test(operand))
) {
  process.stdout.write("invalid\n");
  process.exitCode = 2;
} else {
  process.stdout.write(`${operands.map(Number).reduce((a, b) => a + b, 0)}\n`);
}
