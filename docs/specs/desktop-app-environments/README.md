# Desktop application environments

Goal: REA turns an application installed and used on a Linux desktop into an
agent environment's computer application. The real application installs into
a computer image, launches to ready, exposes reset, load and get over its own
state, and ships with tasks graded through that state.

The work lands as one PR per step:

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
15. [Several tasks](several-tasks/spec.md): one capture yields several
    tasks, each checked at its own end checkpoint and, when one was taken,
    failing at its near miss; the eval lists them all and each is witnessed
    on its own fresh computer.

Version 1 covers Linux with X11, applications whose state lives in files or
SQLite under the home directory, and real applications from public packages.
It uses the user's real state and keeps everything local.
