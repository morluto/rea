# Desktop application environments

This roadmap records the planned implementation sequence. It does not establish
current completion, review approval or verification status. For current workflows,
see [desktop capture](../../desktop-application-capture.md),
[build computers](../../desktop-build-computer.md),
[tasks](../../desktop-application-tasks.md) and
[export](../../desktop-application-export.md). Individual verification records
retain their original scope and limitations.

Goal: REA turns an application installed and used on a Linux desktop into an
agent environment's computer application. The real application installs into
a computer image, launches to ready, exposes reset, load and get over its own
state, and ships with tasks graded through that state.

The planned sequence was one PR per step:

1. Pin the real agent environment lane to the framework release that carries
   the computer application contract.
2. [Capture](capture/spec.md): launch the application on the user's desktop
   and record its inventory, windows and home-directory state at checkpoints.
3. [State view](state-view/spec.md): decide which paths are the application's
   state and read their formats into a typed JSON view.
4. [Export](export/spec.md): write the computer application class, environment
   card, skill and seed.
5. Verification inside an agent environment computer: put, boot, ready, reset
   equals the seed, grader checks.
6. [Tasks](tasks/spec.md): an agent writes a prompt and declarative checks
   from the observed change, REA keeps the task when the checks fail on the
   seed and pass on the captured end state, and a run of the bundle measures
   an agent's solve rate.
7. Three applications end to end: Mousepad (plain files), GnuCash saving to
   SQLite, and Joplin (Electron, SQLite).
8. [Vendor packages](vendor-packages/spec.md): closed-source applications from
   a vendor apt repository, with its verified signing key and the packages of
   the libraries they load, starting with Typora.
9. [Vendor .deb files](vendor-deb-files/spec.md): closed-source applications
   installed from a downloaded `.deb` file, which the computer downloads from
   an operator's URL and checks by its captured SHA-256, starting with
   VariCAD.
10. [Document views](document-views/spec.md): documents saved as zip
    archives (FreeCAD, OpenDocument, Office Open XML, EPUB) read as their
    entries, checked by name rather than position, namespaced XML included,
    and numbers compared within a tolerance, starting with FreeCAD.
11. [Capture for building](capture-for-building/spec.md): one capture makes
    the seed and then the change, at checkpoints the export and the task
    draft are told; apt lists from a user-space `apt-get update` are found;
    the application does not inherit the computer's control token; and the
    bundle holds neither the capture host's name nor its user's.
12. [Build computer](build-computer/spec.md): an agentenv computer REA keeps
    up from a request or a bundle, with REA installed inside for building,
    driven through REA's MCP tools while an agent builds the environment.
13. [Build and witness](build-witness/spec.md): REA's capture, task draft
    and export run inside the build computer with acknowledged checkpoints,
    the bundle comes back to the host, and the task is witnessed live in a
    fresh computer of it: seed, edit, near miss and reset, recorded.
14. [XML text checks](xml-text-checks/spec.md): XML whose DOCTYPE only names
    its DTD read as XML, starting with AbiWord, and checks of an element's
    whole text across the runs an app splits a paragraph into.
15. [Download installs](download-installs/spec.md): applications no package
    offers, from their project's AppImage or tarball pinned by URL and
    SHA-256, unpacked under `/opt/rea-apps` by the build computer and the
    export alike, starting with FreeCAD.
16. [Readers](file-readers/spec.md): checks of a file REA reads as binary,
    such as GIMP's `.xcf` or Blender's `.blend`, through the app's own
    headless command, run in the computer on a private copy of the file.
17. [Screen judges](screen-judge/spec.md): checks of state no file shows,
    such as a calculator's result, by a model judging a screenshot against
    the build's labelled seed and end screenshots.
18. [Secrets typed unseen](build-secrets/spec.md): a password or key the
    person keeps in a file on the build host, typed by its handle, which no
    result, log, record or exported bundle holds; sign-in and licence state
    withheld from the seed and supplied at run time, seeded only with the
    person's recorded consent; known handle values are checked explicitly.
19. [Several tasks](several-tasks/spec.md): one capture yields several
    tasks, each checked at its own end checkpoint and, when one was taken,
    failing at its near miss; the eval lists them all and each is witnessed
    on its own fresh computer.
20. [Task difficulty](task-difficulty/spec.md): a build tool solves a
    bundle's task in fresh computers for a model, 3 times and 2 more unless
    they passed none or all, within a budget, and records its band, cost,
    turns and failures per check in the bundle.

Version 1 covers Linux with X11, applications whose state lives in files or
SQLite under the home directory, and real applications from public packages.
It uses the user's real state and keeps everything local.
