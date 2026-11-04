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
4. Export: write the computer application class, environment card, skill and
   seed.
5. Verification inside an agent environment computer: put, boot, ready, reset
   equals the seed, grader checks.
6. Tasks from the observed kinds of change, with a reference agent's solve
   rate.
7. Three applications end to end: Mousepad (plain files), GnuCash saving to
   SQLite, and Joplin (Electron, SQLite).

Version 1 covers Linux with X11, applications whose state lives in files or
SQLite under the home directory, and real applications from public packages.
It uses the user's real state and keeps everything local.
