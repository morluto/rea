function searchNotes(notes, query) {
  const needle = query.trim().toLowerCase();
  if (needle === "") return [];
  return notes.filter(
    (note) =>
      note.title.toLowerCase().includes(needle) ||
      note.body.toLowerCase().includes(needle),
  );
}

module.exports = { searchNotes };
