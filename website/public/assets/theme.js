// This small, blocking head script applies the theme before the first paint.
(() => {
  const root = document.documentElement;
  const storageKey = "rea-theme";
  const parseChoice = (value) =>
    value === "light" || value === "dark" ? value : null;
  let choice = null;
  let storage = null;
  try {
    storage = window.localStorage;
    choice = parseChoice(storage.getItem(storageKey));
  } catch {
    // The switch still works when browser storage is unavailable.
  }

  const applyTheme = () => {
    // Light is the base theme; dark applies only after the reader chooses it.
    const theme = choice ?? "light";
    root.dataset.theme = theme;
    document.querySelector('meta[name="theme-color"]').content =
      theme === "dark" ? "#151513" : "#f1efeb";
    window.dispatchEvent(new Event("website-theme-change"));
  };

  applyTheme();
  window.addEventListener("storage", (event) => {
    if (
      storage !== null &&
      event.storageArea === storage &&
      (event.key === storageKey || event.key === null)
    ) {
      try {
        // Another tab may have written a newer choice while this event waited.
        choice = parseChoice(storage.getItem(storageKey));
      } catch {
        return;
      }
      applyTheme();
    }
  });

  // Homepage motion: headlines rise word by word, sections and photographs
  // reveal once as they enter the viewport. Enabled only when the browser can
  // observe elements and the reader allows motion, so content is never left
  // hidden.
  const motion =
    "IntersectionObserver" in window &&
    !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (motion) root.classList.add("motion-ready");

  const splitWords = (heading) => {
    heading.setAttribute(
      "aria-label",
      heading.textContent.replace(/\s+/g, " ").trim(),
    );
    let index = 0;
    const walk = (node) => {
      Array.from(node.childNodes).forEach((child) => {
        if (child.nodeType === Node.ELEMENT_NODE) {
          walk(child);
          return;
        }
        if (
          child.nodeType !== Node.TEXT_NODE ||
          child.textContent.trim() === ""
        )
          return;
        const fragment = document.createDocumentFragment();
        child.textContent.split(/(\s+)/).forEach((part) => {
          if (part === "") return;
          if (/^\s+$/.test(part)) {
            fragment.append(" ");
            return;
          }
          const word = document.createElement("span");
          const inner = document.createElement("span");
          word.className = "word";
          word.setAttribute("aria-hidden", "true");
          inner.textContent = part;
          inner.style.setProperty("--w", String(index++));
          word.append(inner);
          fragment.append(word);
        });
        child.replaceWith(fragment);
      });
    };
    walk(heading);
    heading.classList.add("is-split");
  };

  const initializeReveal = () => {
    if (!motion) return;
    document
      .querySelectorAll(".home-hero h1, .home-section h2")
      .forEach(splitWords);
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          entry.target.classList.add("is-in");
          observer.unobserve(entry.target);
        });
      },
      { rootMargin: "0px 0px -12% 0px" },
    );
    document
      .querySelectorAll(
        ".home-split-heading, .home-example-question, .home-start-content, .home-card, .home-example-answer, .home-start-image, .home-caption, .lcd-device, .calculator-result",
      )
      .forEach((element) => {
        const siblings = Array.from(element.parentElement.children);
        element.style.setProperty("--i", String(siblings.indexOf(element)));
        Array.from(element.children).forEach((child, index) => {
          child.style.setProperty("--c", String(index));
        });
        observer.observe(element);
      });
    document
      .querySelectorAll(".lcd-digits g:first-of-type rect")
      .forEach((segment) => {
        const siblings = Array.from(segment.parentElement.children);
        segment.style.setProperty("--s", String(siblings.indexOf(segment)));
      });
    document
      .querySelectorAll(".mini-requests tr, .mini-tools li")
      .forEach((row) => {
        const siblings = Array.from(row.parentElement.children);
        row.style.setProperty("--r", String(siblings.indexOf(row)));
      });
  };

  const initializeToggle = async () => {
    const button = document.querySelector("[data-theme-toggle]");
    if (button === null) return;
    const { t } = await import("./i18n.js");
    const updateLabel = () => {
      const label =
        root.dataset.theme === "dark"
          ? t("Switch to light mode")
          : t("Switch to dark mode");
      button.setAttribute("aria-label", label);
      button.title = label;
    };
    window.addEventListener("website-theme-change", updateLabel);
    button.addEventListener("click", () => {
      choice = root.dataset.theme === "dark" ? "light" : "dark";
      try {
        storage?.setItem(storageKey, choice);
      } catch {
        // Retain the choice for this page even if it cannot be saved.
      }
      applyTheme();
    });
    updateLabel();
    button.hidden = false;
  };
  document.addEventListener("DOMContentLoaded", () => {
    initializeReveal();
    initializeToggle().catch((cause) => {
      console.error("Theme toggle initialization failed", cause);
    });
  });
})();
