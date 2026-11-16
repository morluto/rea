/*
 * The ranking is adapted from Incur's command suggestion.
 * Copyright (c) 2025-present weth, LLC
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to
 * deal in the Software without restriction, including without limitation the
 * rights to use, copy, modify, merge, publish, distribute, sublicense, and/or
 * sell copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
 * FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS
 * IN THE SOFTWARE.
 */

/** The edit distance between two strings. */
const editDistance = (left: string, right: string): number => {
  const row = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    let diagonal = row[0]!;
    row[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const above = row[j]!;
      row[j] =
        left[i - 1] === right[j - 1]
          ? diagonal
          : 1 + Math.min(diagonal, above, row[j - 1]!);
      diagonal = above;
    }
  }
  return row[right.length]!;
};

/**
 * The command a mistyped name most likely meant, or undefined. Candidates
 * that extend the input rank first, then ones that contain it, then ones
 * within a small edit distance (2 for inputs of up to 4 characters, otherwise
 * half the input's length). Within a tier the smallest distance wins, and the
 * first candidate wins a tie. Case is ignored.
 */
export const suggestCommand = (
  input: string,
  candidates: Iterable<string>,
): string | undefined => {
  const threshold = input.length <= 4 ? 2 : Math.floor(input.length / 2);
  const lower = input.toLowerCase();
  let best: string | undefined;
  let bestScore = Infinity;
  for (const candidate of candidates) {
    const name = candidate.toLowerCase();
    const distance = editDistance(lower, name);
    const score =
      name.startsWith(lower) && name !== lower
        ? distance
        : name.includes(lower)
          ? 100 + distance
          : distance <= threshold
            ? 200 + distance
            : undefined;
    if (score !== undefined && score < bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return best;
};
