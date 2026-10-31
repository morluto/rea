async function initializeWebsite() {
  const { t } = await import("./i18n.js");

  function initializeCopyButtons() {
    document.querySelectorAll("[data-copy]").forEach((button) => {
      // Icon-only buttons keep their accessible name and show a tick instead.
      const iconOnly = button.classList.contains("copy-icon");
      const label = button.textContent;
      let reset;
      button.addEventListener("click", async () => {
        const target = document.getElementById(
          button.getAttribute("data-copy"),
        );
        if (target === null) return;

        const status = document.getElementById("copy-status");
        const content = target.textContent.trim();
        const text =
          target.closest("pre") === null
            ? content.replace(/\s+/g, " ")
            : content;
        let feedback;
        try {
          await navigator.clipboard.writeText(text);
          feedback = t("Copied");
          button.classList.add("is-copied");
          if (status !== null)
            status.textContent = t("Code copied to clipboard.");
        } catch {
          const range = document.createRange();
          range.selectNodeContents(target);
          const selection = window.getSelection();
          if (selection !== null) {
            selection.removeAllRanges();
            selection.addRange(range);
          }
          feedback = t("Selected");
          if (status !== null)
            status.textContent = t(
              "Code selected. Use your keyboard to copy it.",
            );
        }
        if (!iconOnly) button.textContent = feedback;

        window.clearTimeout(reset);
        reset = window.setTimeout(() => {
          if (!iconOnly) button.textContent = label;
          button.classList.remove("is-copied");
        }, 2000);
      });
    });
  }

  initializeCopyButtons();

  function initializeStepComparisons() {
    document
      .querySelectorAll("[data-step-comparison]")
      .forEach((comparison) => {
        const buttons = comparison.querySelectorAll("[data-select-step]");
        const selectStep = (button) => {
          const selected = button.getAttribute("data-select-step");
          buttons.forEach((candidate) => {
            candidate.setAttribute(
              "aria-pressed",
              String(candidate === button),
            );
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
        };
        buttons.forEach((button) => {
          button.addEventListener("click", () => selectStep(button));
        });
        const initial = Array.from(buttons).find(
          (button) => button.getAttribute("aria-pressed") === "true",
        );
        if (initial) selectStep(initial);
      });
  }

  initializeStepComparisons();

  function initializeLinkedDetails() {
    const revealTarget = (fragment) => {
      if (!fragment.startsWith("#")) return;
      let id;
      try {
        id = decodeURIComponent(fragment.slice(1));
      } catch {
        return;
      }
      const target = document.getElementById(id);
      let opened = false;
      for (let element = target; element; element = element.parentElement) {
        if (element instanceof HTMLDetailsElement && !element.open) {
          element.open = true;
          opened = true;
        }
      }
      if (opened) target.scrollIntoView({ block: "start" });
    };
    window.addEventListener("hashchange", () =>
      revealTarget(window.location.hash),
    );
    document.querySelectorAll('a[href^="#"]').forEach((link) => {
      link.addEventListener("click", () =>
        revealTarget(link.getAttribute("href")),
      );
    });
    revealTarget(window.location.hash);
  }

  initializeLinkedDetails();

  // The setup step rail marks steps above the reading position as done and the
  // one being read as current, with a "Step 2 of 4" summary for small screens.
  function initializeStepRail() {
    const rail = document.querySelector("[data-step-rail]");
    if (rail === null) return;
    const links = Array.from(rail.querySelectorAll("ol a"));
    const sections = links.map((link) =>
      document.getElementById(link.getAttribute("href").slice(1)),
    );
    if (sections.some((section) => section === null)) return;
    const progress = rail.querySelector("[data-step-progress]");

    const update = () => {
      const line = window.innerHeight * 0.35;
      let current = 0;
      sections.forEach((section, index) => {
        if (section.getBoundingClientRect().top <= line) current = index;
      });
      links.forEach((link, index) => {
        link.classList.toggle("is-done", index < current);
        if (index === current) link.setAttribute("aria-current", "step");
        else link.removeAttribute("aria-current");
      });
      if (progress !== null) {
        progress.textContent = t("Step {number} of {total}", {
          number: current + 1,
          total: links.length,
        });
        progress.hidden = false;
      }
    };
    let frame = 0;
    window.addEventListener(
      "scroll",
      () => {
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(update);
      },
      { passive: true },
    );
    update();
  }

  initializeStepRail();

  // Topic lists marked data-scrollspy highlight the section being read.
  function initializeScrollSpy() {
    document.querySelectorAll("nav[data-scrollspy]").forEach((nav) => {
      const links = Array.from(nav.querySelectorAll('a[href^="#"]'));
      const sections = links.map((link) =>
        document.getElementById(link.getAttribute("href").slice(1)),
      );
      if (sections.some((section) => section === null)) return;
      const update = () => {
        const line = window.innerHeight * 0.35;
        let current = 0;
        sections.forEach((section, index) => {
          if (section.getBoundingClientRect().top <= line) current = index;
        });
        links.forEach((link, index) => {
          if (index === current) link.setAttribute("aria-current", "true");
          else link.removeAttribute("aria-current");
        });
      };
      let frame = 0;
      window.addEventListener(
        "scroll",
        () => {
          cancelAnimationFrame(frame);
          frame = requestAnimationFrame(update);
        },
        { passive: true },
      );
      update();
    });
  }

  initializeScrollSpy();

  async function initializeGitHubStars() {
    const link = document.querySelector(".nav-github");
    const stars = link?.querySelector(".nav-github-stars");
    const count = stars?.querySelector(".nav-github-count");
    if (count === null || count === undefined) return;

    try {
      const response = await fetch("https://api.github.com/repos/morluto/rea", {
        headers: { Accept: "application/vnd.github+json" },
        credentials: "omit",
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) return;
      const repository = await response.json();
      const total = repository.stargazers_count;
      if (!Number.isSafeInteger(total) || total < 0) return;

      const language = document.documentElement.lang;
      const formatted = new Intl.NumberFormat(language).format(total);
      const label = t("REA on GitHub ({count})", { count: formatted });
      count.textContent = new Intl.NumberFormat(language, {
        notation: "compact",
        maximumFractionDigits: 1,
      }).format(total);
      stars.hidden = false;
      link.setAttribute("aria-label", label);
      link.setAttribute("title", label);
    } catch {
      // Keep the repository link usable when GitHub is unavailable.
    }
  }

  return initializeGitHubStars();
}

initializeWebsite().catch((cause) => {
  console.error("Website initialization failed", cause);
});
