# Tasks

- [x] Classify path-shaped and URL-shaped literals and retain the missed
      wrapper, array and base-URL candidates as inferences.
- [x] Keep the earliest source coordinate, including a nested array element.
- [x] Bound the inventory with `web.bundle_endpoint_literal_candidates`,
      including launch seed, runtime update, rejection outside the range, and
      partial coverage.
- [x] Send the accepted ceiling on the worker request for that analysis.
- [x] Read the traversal parent first and snapshot ancestors only for a
      URL-shaped initializer.
- [x] Document the heuristic in the browser guide and this feature record.
- [ ] Compare candidates with a real browser capture. The current fixtures are
      synthesized scripts and a simulated CDP source.
