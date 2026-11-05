# Plan

1. Pure parsers: desktop entries and `Exec` lines, `xprop` output, dpkg and
   apt-cache output, package kinds from paths, and the walk diff.
2. Host adapters: the home walk, the content store, the application
   inventory, the `xprop` window observer and the session loop.
3. Application service: host checks, checkpoints, Evidence and the capture
   folder.
4. CLI: `capture-desktop-application`, stdin requests and progress lines.
5. Docs: the user guide and links from the index, sidebar, README and CLI
   reference.
6. Tests: parser units, adapter tests on temporary trees, service refusals,
   and two Linux captures of a fake application with a stub `xprop`.
7. End to end: Mousepad in an Ubuntu 24.04 container under Xvfb and xfwm4,
   driven by `xdotool`, with a screen recording.
