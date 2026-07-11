const cursor = document.getElementById("cur");

if (cursor) {
  document.addEventListener("mousemove", (event) => {
    cursor.style.left = `${event.clientX}px`;
    cursor.style.top = `${event.clientY}px`;
  });

  document.querySelectorAll("a,button").forEach((element) => {
    element.addEventListener("mouseenter", () =>
      cursor.classList.add("expand"),
    );
    element.addEventListener("mouseleave", () =>
      cursor.classList.remove("expand"),
    );
  });
}

const revealObserver = new IntersectionObserver(
  (entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.classList.add("in");
      }
    });
  },
  { threshold: 0.1 },
);

document.querySelectorAll(".sr").forEach((element) => {
  // Mark elements already in the viewport immediately to avoid flash of invisible content
  if (element.getBoundingClientRect().top < window.innerHeight) {
    element.classList.add("in");
  }
  revealObserver.observe(element);
});

void (async () => {
  const versionBadge = document.getElementById("version-badge");

  if (versionBadge) {
    try {
      const response = await fetch(
        "https://api.github.com/repos/BYK/loreai/releases/latest",
      );

      if (response.ok) {
        const data = await response.json();
        versionBadge.textContent = `v${data.tag_name || "0.13.4"}`;
      } else {
        versionBadge.textContent = "v0.13.4";
      }
    } catch {
      versionBadge.textContent = "v0.13.4";
    }
  }
})();

const LOOPS_ENDPOINT =
  "https://app.loops.so/api/newsletter-form/cmpemslgp03m10jxaipjw78iq";
const RATE_LIMIT_KEY = "loops-form-timestamp";
const RATE_LIMIT_MS = 60_000;

const form = document.getElementById("waitlist-form");
const email = document.getElementById("waitlist-email");
const button = document.getElementById("waitlist-btn");
const formView = document.getElementById("waitlist-form-view");
const successView = document.getElementById("waitlist-success");
const errorView = document.getElementById("waitlist-error");
const errorMessage = document.getElementById("waitlist-error-msg");
const retryButton = document.getElementById("waitlist-retry");

function showView(view) {
  formView?.classList.remove("show");
  successView?.classList.remove("show");
  errorView?.classList.remove("show");
  view?.classList.add("show");
}

function showError(message) {
  if (errorMessage) {
    errorMessage.textContent =
      message || "Something went wrong. Please try again.";
  }

  showView(errorView);
  retryButton?.focus();
}

retryButton?.addEventListener("click", () => {
  showView(formView);
  email?.focus();
});

// oxlint-disable-next-line typescript/no-misused-promises -- DOM submit handler; the event target ignores the returned promise
form?.addEventListener("submit", async (event) => {
  event.preventDefault();

  if (
    !(email instanceof HTMLInputElement) ||
    !(button instanceof HTMLButtonElement)
  ) {
    return;
  }

  const value = email.value.trim();

  if (!value) {
    return;
  }

  let last = 0;

  try {
    last = Number.parseInt(localStorage.getItem(RATE_LIMIT_KEY) || "0", 10);
  } catch {
    last = 0;
  }

  if (Date.now() - last < RATE_LIMIT_MS) {
    showError("Too many attempts. Please try again in a minute.");
    return;
  }

  button.textContent = "Sending...";
  button.disabled = true;

  try {
    const response = await fetch(LOOPS_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ email: value }),
    });

    const data = await response.json();

    if (response.ok || data.message === "Email already on list.") {
      try {
        localStorage.setItem(RATE_LIMIT_KEY, String(Date.now()));
      } catch {
        // Ignore localStorage failures; the server still accepted the signup.
      }

      email.value = "";
      showView(successView);
    } else {
      showError(data.message || null);
    }
  } catch {
    showError("Network error. Please check your connection and try again.");
  } finally {
    button.textContent = "Join Waitlist";
    button.disabled = false;
  }
});
