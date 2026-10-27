// Public-page interactions. Commands and destination URLs remain static markup.
const releaseLinks = document.querySelectorAll(".release-link");
if (releaseLinks.length) {
  void (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(
        "https://api.github.com/repos/BYK/loreai/releases/latest",
        { signal: controller.signal },
      );
      if (!response.ok) return;
      const data = await response.json();
      if (
        typeof data?.tag_name !== "string" ||
        !/^v?\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(data.tag_name)
      )
        return;
      const version = data.tag_name.replace(/^v/, "");
      releaseLinks.forEach((link) => {
        link.textContent = `Latest: v${version}`;
      });
    } catch {
      // The existing Releases link remains useful without a version lookup.
    } finally {
      clearTimeout(timer);
    }
  })();
}

const form = document.getElementById("waitlist-form");
const email = document.getElementById("waitlist-email");
const button = document.getElementById("waitlist-btn");
const formView = document.getElementById("waitlist-form-view");
const successView = document.getElementById("waitlist-success");
const errorView = document.getElementById("waitlist-error");
const errorMessage = document.getElementById("waitlist-error-msg");
const retryButton = document.getElementById("waitlist-retry");
const rateKey = "loops-form-timestamp";
let submitting = false;

function showView(view) {
  [formView, successView, errorView].forEach((element) =>
    element?.classList.remove("show"),
  );
  view?.classList.add("show");
  if (view !== formView) view?.focus();
}
function showError(message) {
  if (errorMessage) errorMessage.textContent = message;
  showView(errorView);
}
retryButton?.addEventListener("click", () => {
  showView(formView);
  email?.focus();
});

// oxlint-disable-next-line typescript/no-misused-promises -- DOM event callbacks ignore the returned promise
form?.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (
    !(email instanceof HTMLInputElement) ||
    !(button instanceof HTMLButtonElement) ||
    submitting
  )
    return;
  const value = email.value.trim();
  if (!value || !email.checkValidity()) return;
  let last = 0;
  try {
    last = Number.parseInt(localStorage.getItem(rateKey) || "0", 10);
  } catch {
    /* Storage is optional. */
  }
  if (Date.now() - last < 60_000) {
    showError(
      "You recently joined this list. Wait a minute before trying again.",
    );
    return;
  }
  submitting = true;
  button.disabled = true;
  button.textContent = "Joining…";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(form.action, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ email: value }),
      signal: controller.signal,
    });
    let data = null;
    try {
      data = await response.json();
    } catch {
      /* A successful response need not contain JSON. */
    }
    if (response.ok || data?.message === "Email already on list.") {
      try {
        localStorage.setItem(rateKey, String(Date.now()));
      } catch {
        /* The server accepted the signup. */
      }
      email.value = "";
      showView(successView);
    } else {
      showError(
        "We couldn’t add your email. Your address has been kept so you can try again.",
      );
    }
  } catch {
    showError(
      controller.signal.aborted
        ? "The request timed out. Try again when your connection is ready."
        : "We couldn’t reach the signup service. Check your connection and try again.",
    );
  } finally {
    clearTimeout(timer);
    submitting = false;
    button.disabled = false;
    button.textContent = "Join early access list";
  }
});
