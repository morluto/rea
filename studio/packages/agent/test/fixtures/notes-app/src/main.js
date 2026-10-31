const { searchNotes } = require("./search");

const notes = [
  { id: 1, title: "Groceries", body: "milk, eggs" },
  { id: 2, title: "Ideas", body: "rewrite the search in Rust" },
];

function handleSearch(query) {
  return searchNotes(notes, query).map((note) => note.title);
}

module.exports = { handleSearch };
