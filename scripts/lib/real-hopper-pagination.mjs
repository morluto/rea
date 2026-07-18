const PAGE_LIMIT = 100;

/** Open the large fixture and exhaustively prove its public search pages. */
export async function openAndVerifyLargeFixture({
  client,
  options,
  normalizedResult,
  path,
  expectedCount,
  symbolPrefix,
  stringPrefix,
}) {
  const opened = await client.callTool(
    { name: "open_binary", arguments: { path } },
    options,
  );
  if (opened.isError === true)
    throw new Error("Hopper rejected the large fixture");
  return verifyLargeFixturePagination({
    client,
    options,
    normalizedResult,
    expectedCount,
    symbolPrefix,
    stringPrefix,
  });
}

/** Exhaustively prove the source-owned large fixture through public search pages. */
export async function verifyLargeFixturePagination({
  client,
  options,
  normalizedResult,
  expectedCount,
  symbolPrefix,
  stringPrefix,
}) {
  const procedures = await collectExactPages({
    client,
    options,
    normalizedResult,
    tool: "search_procedures",
    pattern: symbolPrefix.replace(/^_+/u, ""),
    expectedPrefix: symbolPrefix.replace(/^_+/u, ""),
    expectedCount,
    normalize: (value) => value.replace(/^_+/u, ""),
  });
  const strings = await collectExactPages({
    client,
    options,
    normalizedResult,
    tool: "search_strings",
    pattern: stringPrefix,
    expectedPrefix: stringPrefix,
    expectedCount,
    normalize: (value) => value,
  });
  return { procedures, strings };
}

async function collectExactPages({
  client,
  options,
  normalizedResult,
  tool,
  pattern,
  expectedPrefix,
  expectedCount,
  normalize,
}) {
  const seenAddresses = new Set();
  const seenValues = new Set();
  let offset = 0;
  let pages = 0;
  while (true) {
    const page = normalizedResult(
      await client.callTool(
        {
          name: tool,
          arguments: {
            pattern,
            mode: "literal",
            case_sensitive: true,
            offset,
            limit: PAGE_LIMIT,
          },
        },
        options,
      ),
      `${tool} offset ${offset}`,
    );
    validatePage(page, { offset, expectedCount });
    for (const item of page.items) {
      const value = normalize(item.value);
      if (item.value_truncated || !/^0x[0-9a-f]+$/iu.test(item.address))
        throw new Error(`${tool} returned truncated or malformed evidence`);
      if (seenAddresses.has(item.address) || seenValues.has(value))
        throw new Error(`${tool} returned duplicate evidence`);
      seenAddresses.add(item.address);
      seenValues.add(value);
    }
    pages += 1;
    if (page.next_offset === null) break;
    offset = page.next_offset;
  }
  const expectedValues = Array.from(
    { length: expectedCount },
    (_, index) => `${expectedPrefix}${String(index).padStart(4, "0")}`,
  );
  if (
    seenValues.size !== expectedCount ||
    expectedValues.some((value) => !seenValues.has(value))
  )
    throw new Error(`${tool} did not exhaustively prove the fixture values`);
  return { count: seenValues.size, pages };
}

function validatePage(page, { offset, expectedCount }) {
  if (
    page === null ||
    typeof page !== "object" ||
    !Array.isArray(page.items) ||
    page.offset !== offset ||
    page.limit !== PAGE_LIMIT ||
    page.total !== expectedCount ||
    page.items.length !== Math.min(PAGE_LIMIT, expectedCount - offset)
  )
    throw new Error("Hopper returned an inconsistent fixture search page");
  const expectedNext =
    offset + page.items.length < expectedCount
      ? offset + page.items.length
      : null;
  if (
    page.next_offset !== expectedNext ||
    page.has_more !== (expectedNext !== null)
  )
    throw new Error("Hopper returned inconsistent pagination metadata");
}
