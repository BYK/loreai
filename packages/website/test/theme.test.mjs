import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { test } from "node:test";

const source = readFileSync(
  new URL("../src/scripts/theme.js", import.meta.url),
  "utf8",
);

function browser({ stored = null, dark = false, blocked = false } = {}) {
  const listeners = {};
  const buttons = ["auto", "light", "dark"].map((choice) => ({
    dataset: { themeChoice: choice },
    attributes: {},
    closest() {
      return null;
    },
    setAttribute(name, value) {
      this.attributes[name] = value;
    },
    addEventListener(name, handler) {
      this[name] = handler;
    },
  }));
  const root = { dataset: {}, style: {} };
  const storage = new Map(stored === null ? [] : [["starlight-theme", stored]]);
  const media = {
    matches: dark,
    addEventListener(name, handler) {
      this[name] = handler;
    },
  };
  const document = {
    documentElement: root,
    readyState: "loading",
    querySelectorAll(selector) {
      return selector === "button[data-theme-choice]" ? buttons : [];
    },
    addEventListener(name, handler) {
      listeners[name] = handler;
    },
  };
  const window = {
    matchMedia() {
      return media;
    },
    addEventListener(name, handler) {
      listeners[name] = handler;
    },
    localStorage: {
      getItem(key) {
        if (blocked) throw Error("blocked");
        return storage.get(key) ?? null;
      },
      setItem(key, value) {
        if (blocked) throw Error("blocked");
        storage.set(key, value);
      },
      removeItem(key) {
        if (blocked) throw Error("blocked");
        storage.delete(key);
      },
    },
  };
  runInNewContext(source, { window, document });
  // The palette must resolve in the head, before any controls exist.
  assert.equal(
    root.dataset.theme,
    stored === "light" || stored === "dark" ? stored : dark ? "dark" : "light",
  );
  listeners.DOMContentLoaded();
  return {
    root,
    buttons,
    storage,
    listeners,
    media,
    click(choice) {
      buttons.find((button) => button.dataset.themeChoice === choice).click();
    },
    system(next) {
      media.matches = next;
      media.change();
    },
  };
}

for (const dark of [false, true]) {
  await test(`system theme resolves before paint (${dark ? "dark" : "light"})`, () => {
    const env = browser({ dark });
    assert.equal(env.root.dataset.themeChoice, "auto");
    assert.equal(env.buttons[0].attributes["aria-pressed"], "true");
    env.system(!dark);
    assert.equal(env.root.dataset.theme, dark ? "light" : "dark");
  });
}

await test("explicit choice persists and ignores system changes", () => {
  const env = browser();
  env.click("dark");
  assert.equal(env.storage.get("starlight-theme"), "dark");
  assert.equal(env.buttons[2].attributes["aria-pressed"], "true");
  assert.equal(env.buttons[0].attributes["aria-pressed"], "false");
  env.system(false);
  assert.equal(env.root.dataset.theme, "dark");
  browser({ stored: env.storage.get("starlight-theme") });
});

await test("System clears the override and immediately follows the OS", () => {
  const env = browser({ stored: "dark" });
  env.click("auto");
  assert.equal(env.storage.has("starlight-theme"), false);
  assert.equal(env.root.dataset.theme, "light");
  env.system(true);
  assert.equal(env.root.dataset.theme, "dark");
});

await test("stored light takes precedence over a dark OS", () => {
  const env = browser({ stored: "light", dark: true });
  assert.equal(env.root.dataset.themeChoice, "light");
  assert.equal(env.buttons[1].attributes["aria-pressed"], "true");
});

await test("invalid storage values follow the system", () => {
  browser({ stored: "sepia", dark: true });
});

await test("blocked storage still allows an in-memory override", () => {
  const env = browser({ blocked: true });
  env.click("dark");
  env.system(false);
  assert.equal(env.root.dataset.theme, "dark");
  env.click("auto");
  assert.equal(env.root.dataset.theme, "light");
});

await test("theme and storage-clear events from another tab update every control", () => {
  const env = browser();
  env.listeners.storage({ key: "starlight-theme", newValue: "dark" });
  assert.equal(env.root.dataset.theme, "dark");
  assert.equal(env.buttons[2].attributes["aria-pressed"], "true");
  env.listeners.storage({ key: "unrelated", newValue: "light" });
  assert.equal(env.root.dataset.theme, "dark");
  env.listeners.storage({ key: null, newValue: null });
  assert.equal(env.root.dataset.theme, "light");
});
