# Implementation plan

1. Add one dependency selector that follows npm's `os`, `cpu`, `libc`, and
   optional-package semantics against the lockfile, and one inventory owner that
   bounds the manifest and hashes files with streamed reads.
2. Add the Windows package builder: validate the local Node distribution, run
   the existing dependency and native-artifact checks, copy the packed
   application files and selected dependencies, install the bundled runtime and
   launchers, copy the portable guide, and publish `portable.json` last.
3. Add the PowerShell launcher and runtime bootstrap, including literal argument
   forwarding, live stdio MCP inheritance, caller working-directory preservation,
   and package-runner context clearing.
4. Add the portable verifier around `VerifierFixture`: check the exact inventory
   and digests, exercise the shipped launchers and a negative network-guard
   control, run offline setup/doctor and repeated setup, compare CLI/MCP
   JavaScript analysis, preserve source, and uninstall. Use a plain child scratch
   root because the analysis worker creates its own private runtime beneath it.
5. Add focused dependency, inventory, command, fixture, and CI-routing tests;
   extend the Windows curated lane with portable preparation and both shell
   verifiers; add the preparation guide and documentation navigation.
6. Resolve review findings at their owning boundary: verify the network guard
   before reporting it, verify hashes through the inventory owner, inherit MCP
   stderr instead of leaving a piped stream unread, derive the documented Node
   version from `.nvmrc`, and keep the packaged-guide change on the package lane.
7. Run focused tests, static checks, documentation checks, the real Windows
   package and verifier, and the final-head CI run; report any remaining
   external or unrelated gaps rather than broadening this feature.

No new provider, analysis authority, target execution, or release upload is
introduced. The existing CLI, MCP, setup, and analysis implementations remain
the owners of their behavior.
