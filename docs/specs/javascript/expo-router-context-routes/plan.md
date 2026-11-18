# Implementation plan

## Boundary and contract

`src/domain/javascript/javascriptRouteFacts.ts` adds `expo-router-context-key`
to the route mechanism enum. The change is an additive value in existing
output fields. No new tool, provider or bridge is added.

## Owners

- `src/domain/javascript/javascriptRoutePaths.ts` owns
  `classifyExpoRouterContextKey`, which converts one map key into a route path
  or reports it as a convention file. It follows Expo Router's matchers and
  route collection (`build/matchers.js` and `getRoutesCore.js`), next to the
  Next App Router path rules.
- `src/domain/javascript/javascriptRouteScan.ts` collects candidate maps while
  it visits `Object.defineProperties` calls and reads them in
  `#expoRouterContextSteps` after the Next paths and before the structured
  route calls.
- `docs/javascript-route-inventory.md` documents the conventions, the low
  confidence, and why a bundled key adds no classification.

## Reads and budget

The scan reads the map twice. The first pass establishes applicability from
the keys alone and retains no derived path. The second pass emits one fact per
route key through the same emission path as the other mechanisms, so each fact
is charged against the budget before it is kept. Both passes yield between
properties and stop when the result has reached capacity.

## Choices

- A layout or `+` file is required before any key becomes a route. A plain
  file map is also what other `require.context` uses compile to, and reading
  those as routes would invent paths.
- The occurrence keeps `inferred` derivation and low confidence, and adds no
  classification, because the bundle does not say how the file is served.
