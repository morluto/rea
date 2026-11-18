# Expo Router `require.context` route keys

## Problem and outcome

The JavaScript route inventory read router calls, route objects, typed route
trees, Next App Router chunk paths and navigation targets. An Expo Router web
export declares its routes in none of those. Metro compiles the app directory's
`require.context` into `Object.defineProperties({}, {"./file.tsx": getter, ...})`,
so the inventory of such a bundle listed only the navigation strings it
happened to contain. Report each route file of that map as a route candidate,
with the path Expo Router's file conventions give it.

## Requirements

- A candidate map is an `Object.defineProperties` call with exactly two
  arguments: an empty object literal and a nonempty object literal.
- The map is read as Expo Router route files only when every property is a
  non-computed string key shaped `./<file>.js`, `.jsx`, `.ts` or `.tsx`, and at
  least one key is a `_layout` or `+` file.
- A map of route-file keys without a layout or `+` file keeps one
  interpretation unknown for `expo-router-context-key` and produces no route.
  A map with any other key is a different file or data map and produces
  neither routes nor an unknown.
- Each route key is converted with Expo Router's file conventions:
  - groups, including `(a,b)` group arrays, contribute no segment;
  - `[id]` maps to `:id` and `[...rest]` to `:rest+`;
  - a trailing `index` names its directory;
  - `.android`, `.ios`, `.native` and `.web` platform extensions select the
    same route;
  - `+api` files keep their API path;
  - `_layout` files and other `+` files, such as `+not-found` and `+html`, are
    not URL patterns and produce no route.
- Each route key becomes one `expo-router-context-key` occurrence at the key
  literal, with the key as its single literal segment, `inferred` derivation
  and low confidence.
- The key adds no classification of its own: a bundled key does not establish
  which platform, navigator or server serves the file. The existing path-name
  heuristic still applies.
- Keys are admitted one at a time within the fact budget. Applicability is
  established without retaining derived paths, each emitted fact is charged
  before it is kept, and reaching capacity stops the scan with the facts
  admitted so far.

## Acceptance

Scanner tests cover the conversion of a Metro context map (groups and group
arrays, dynamic and catch-all segments, `index`, a platform extension, a
`+api` file, layouts and other `+` files), a file map without conventions that
stays unknown, `Object.defineProperties` shapes that are not context maps, and
admission of keys one at a time within the fact budget. An inventory test
covers the resulting routes, their occurrence fields, the absence of unknowns
and complete candidate enumeration. A CLI acceptance test inventories a Metro
web bundle through the public CLI.

## Out of scope

Which platform, navigator or server serves a route file; route reachability;
Expo Router configuration that moves the app root; typed routes; Hermes
bytecode bundles; and `require.context` maps that are not Expo Router app
directories.
