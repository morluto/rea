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

Version 1 covers Linux with X11, applications whose state lives in files or
SQLite under the home directory, and real applications from public packages.
It uses the user's real state and keeps everything local.
