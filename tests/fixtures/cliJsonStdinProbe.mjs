// Observe the production stdin reader without supplying data or closing its pipe.
const iterate = process.stdin[Symbol.asyncIterator];
process.stdin[Symbol.asyncIterator] = function (...args) {
  process.stderr.write("REA_TEST_STDIN_READ\n");
  return iterate.apply(this, args);
};
