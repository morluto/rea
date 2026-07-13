# Installation roadmap

REA setup currently configures the capabilities that exist today: its agent integrations, bundled skill, and optional Hopper provider.

When REA has at least two real optional toolchains, setup can evolve into a capability-oriented wizard. It may ask whether the operator wants to investigate native binaries, websites, mobile applications, firmware, or runtime protocols, then propose only the tools needed for the selected work.

That future installer must preserve the current safety boundary:

- detect and reuse existing tools;
- disclose every source, destination, license, command, and system effect;
- prefer user-local installation;
- install only explicitly selected toolchains;
- require tool-specific authorization for unattended system changes;
- verify each installed tool before reporting readiness.

No placeholder tool choices or speculative installer registry are implemented until another supported toolchain makes the abstraction concrete.
