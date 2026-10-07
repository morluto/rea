function initializeCopyButtons() {
  document.querySelectorAll("[data-copy]").forEach((button) => {
    button.addEventListener("click", async () => {
      const target = document.getElementById(button.getAttribute("data-copy"));
      if (target === null) return;

      const status = document.getElementById("copy-status");
      const content = target.textContent.trim();
      const text =
        target.closest(".terminal-prompt") === null
          ? content
          : content.replace(/\s+/g, " ");
      try {
        await navigator.clipboard.writeText(text);
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

function initializeStepComparisons() {
  document.querySelectorAll("[data-step-comparison]").forEach((comparison) => {
    const buttons = comparison.querySelectorAll("[data-select-step]");
    buttons.forEach((button) => {
      button.addEventListener("click", () => {
        const selected = button.getAttribute("data-select-step");
        buttons.forEach((candidate) => {
          candidate.setAttribute("aria-pressed", String(candidate === button));
        });
        comparison.querySelectorAll("[data-step]").forEach((fragment) => {
          fragment.classList.toggle(
            "is-active",
            fragment.getAttribute("data-step") === selected,
          );
        });
        comparison.querySelectorAll("[data-step-note]").forEach((note) => {
          note.hidden = note.getAttribute("data-step-note") !== selected;
        });
      });
    });
  });
}

initializeStepComparisons();

function initializeBackToTop() {
  const link = document.querySelector(".back-to-top");
  if (link === null) return;

  const updateVisibility = () => {
    link.hidden = window.scrollY < 400;
  };
  window.addEventListener("scroll", updateVisibility, { passive: true });
  updateVisibility();

  link.addEventListener("click", (event) => {
    event.preventDefault();
    const reduceMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    window.scrollTo({ top: 0, behavior: reduceMotion ? "auto" : "smooth" });
    document
      .querySelector(".brand, .breadcrumb a")
      ?.focus({ preventScroll: true });
  });
}

initializeBackToTop();
