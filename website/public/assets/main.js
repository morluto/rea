async function initializeWebsite() {
  const { t } = await import("./i18n.js");

  function initializeCopyButtons() {
    document.querySelectorAll("[data-copy]").forEach((button) => {
      const label = button.textContent;
      button.addEventListener("click", async () => {
        const target = document.getElementById(
          button.getAttribute("data-copy"),
        );
        if (target === null) return;

        const status = document.getElementById("copy-status");
        const content = target.textContent.trim();
        const text =
          target.closest(".terminal-prompt") === null
            ? content
            : content.replace(/\s+/g, " ");
        try {
          await navigator.clipboard.writeText(text);
          button.textContent = t("Copied");
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
          button.textContent = t("Selected");
          if (status !== null)
            status.textContent = t(
              "Code selected. Use your keyboard to copy it.",
            );
        }

        window.setTimeout(() => {
          button.textContent = label;
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

  async function initializeGitHubStars() {
    const link = document.querySelector(".nav-github");
    const count = link?.querySelector(".nav-github-count");
    if (count === null || count === undefined) return;

    try {
      const response = await fetch("https://api.github.com/repos/morluto/rea", {
        headers: { Accept: "application/vnd.github+json" },
        credentials: "omit",
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) return;
      const repository = await response.json();
      const stars = repository.stargazers_count;
      if (!Number.isSafeInteger(stars) || stars < 0) return;

      const formatted = new Intl.NumberFormat(
        document.documentElement.lang,
      ).format(stars);
      const label = t("REA on GitHub ({count})", { count: formatted });
      count.textContent = formatted;
      count.hidden = false;
      link.setAttribute("aria-label", label);
      link.setAttribute("title", label);
    } catch {
      // Keep the repository link usable when GitHub is unavailable.
    }
  }

  function initializeInteractions() {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    // Ambient cursor glow (pointer only)
    if (window.matchMedia("(pointer: fine)").matches) {
      const glow = document.createElement("div");
      glow.id = "neu-cursor-glow";
      document.body.appendChild(glow);

      let rafId = null;
      let cx = -999,
        cy = -999;
      window.addEventListener(
        "mousemove",
        (e) => {
          cx = e.clientX;
          cy = e.clientY;
          if (rafId !== null) return;
          rafId = requestAnimationFrame(() => {
            glow.style.setProperty("--cx", cx + "px");
            glow.style.setProperty("--cy", cy + "px");
            rafId = null;
          });
        },
        { passive: true },
      );
    }

    // Header scroll elevation
    const header = document.querySelector(".site-header");
    if (header) {
      const onScroll = () => {
        header.classList.toggle("neu-scrolled", window.scrollY > 8);
      };
      window.addEventListener("scroll", onScroll, { passive: true });
      onScroll();
    }

    // Card hover 3D tilt
    const cards = document.querySelectorAll(
      ".home-case-card, .contributor-card, .home-workflow li",
    );
    const MAX_TILT = 3;
    cards.forEach((card) => {
      card.addEventListener("mousemove", (e) => {
        const rect = card.getBoundingClientRect();
        const x = (e.clientX - rect.left) / rect.width - 0.5;
        const y = (e.clientY - rect.top) / rect.height - 0.5;
        card.style.transform = `translateY(-2px) rotateX(${(-y * MAX_TILT).toFixed(2)}deg) rotateY(${(x * MAX_TILT).toFixed(2)}deg)`;
      });
      card.addEventListener("mouseleave", () => {
        card.style.transform = "";
      });
    });
  }

  initializeInteractions();

  return initializeGitHubStars();
}

initializeWebsite().catch((cause) => {
  console.error("Website initialization failed", cause);
});
