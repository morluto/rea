function initializeCopyButtons() {
  document.querySelectorAll("[data-copy]").forEach((button) => {
    button.addEventListener("click", async () => {
      const target = document.getElementById(button.getAttribute("data-copy"));
      if (target === null) return;

      const status = document.getElementById("copy-status");
      try {
        await navigator.clipboard.writeText(target.textContent.trim());
        button.textContent = "Copied";
        if (status !== null) status.textContent = "Code copied to clipboard.";
      } catch {
        const range = document.createRange();
        range.selectNodeContents(target);
        const selection = window.getSelection();
        if (selection !== null) {
          selection.removeAllRanges();
          selection.addRange(range);
        }
        button.textContent = "Selected";
        if (status !== null)
          status.textContent = "Code selected. Use your keyboard to copy it.";
      }

      window.setTimeout(() => {
        button.textContent = "Copy";
      }, 2000);
    });
  });
}

initializeCopyButtons();
