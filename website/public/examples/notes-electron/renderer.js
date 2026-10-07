document.querySelector("#export").addEventListener("click", async () => {
  const destination = await window.notes.exportCsv();
  document.querySelector("#status").textContent = `Saved to ${destination}`;
});
