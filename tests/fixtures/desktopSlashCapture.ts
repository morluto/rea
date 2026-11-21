import {
  HOME,
  change,
  retained,
  seedEndCapture,
} from "../../src/application/desktop/desktopCapture.fixture.js";

/** Authored passive capture fixture: a literal slash key beside a nested key. */
export const desktopSlashCapture = () => {
  const path = `${HOME}/Documents/records.json`;
  const record = (uid: string, title: string) => ({
    uid,
    format: "BOOK",
    data: { Title: title },
    "data/Title": `flat ${title}`,
  });
  const first = record("76cbaf8fda2511f1b9343971baf6a808", "First");
  const second = record("7be27d14da2511f1afb93971baf6a808", "Second");
  const added = record("ae23424ada2511f1bbd43971baf6a808", "New");
  const before = JSON.stringify({ nodes: [first, second] });
  const after = JSON.stringify({ nodes: [first, second, added] });
  const base = seedEndCapture();
  const checkpoints = base.state.checkpoints.map((point) => {
    if (point.name === "seed")
      return {
        ...point,
        changes: [...point.changes, change(path, { after: before })],
        retained: [...point.retained, retained(path, before)],
      };
    if (point.name === "end")
      return {
        ...point,
        changes: [...point.changes, change(path, { before, after })],
        retained: [...point.retained, retained(path, after)],
      };
    return point;
  });
  return {
    recorded: {
      ...base,
      session: {
        ...base.session,
        opened_files: [
          ...base.session.opened_files,
          { path, first_seen_ms: 0 },
        ],
      },
      state: {
        ...base.state,
        content_roots: [...base.state.content_roots, path],
        checkpoints,
        content_files: base.state.content_files + 2,
        content_bytes: base.state.content_bytes + before.length + after.length,
      },
    },
    before,
    after,
  };
};
