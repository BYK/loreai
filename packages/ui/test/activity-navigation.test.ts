import { describe, expect, it } from "vitest";

import { shouldHandleSpace } from "~/state/activity-navigation";
import { absoluteMessageIndex } from "~/state/session-read-position";

describe("workspace keyboard navigation", () => {
  it("handles unmodified Space outside controls and selected text", () => {
    const event = new KeyboardEvent("keydown", { key: " " });
    const prevented = new KeyboardEvent("keydown", { key: " " });
    Object.defineProperty(prevented, "defaultPrevented", { value: true });
    expect(shouldHandleSpace(event, document.body, "")).toBe(true);
    expect(shouldHandleSpace(event, document.body, "selected")).toBe(false);
    expect(shouldHandleSpace(prevented, document.body, "")).toBe(false);
    expect(
      shouldHandleSpace(
        new KeyboardEvent("keydown", { key: " ", ctrlKey: true }),
        document.body,
        "",
      ),
    ).toBe(false);
    for (const modifier of ["altKey", "metaKey", "shiftKey"] as const) {
      expect(
        shouldHandleSpace(
          new KeyboardEvent("keydown", { key: " ", [modifier]: true }),
          document.body,
          "",
        ),
      ).toBe(false);
    }
    for (const tag of ["input", "textarea", "select", "button"]) {
      expect(
        shouldHandleSpace(
          new KeyboardEvent("keydown", { key: " " }),
          document.createElement(tag),
          "",
        ),
      ).toBe(false);
    }
    const editable = document.createElement("div");
    editable.setAttribute("contenteditable", "true");
    expect(shouldHandleSpace(event, editable, "")).toBe(false);
    const readOnly = document.createElement("div");
    readOnly.setAttribute("contenteditable", "false");
    expect(shouldHandleSpace(event, readOnly, "")).toBe(true);
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    const button = document.createElement("button");
    dialog.append(button);
    expect(shouldHandleSpace(event, button, "")).toBe(false);
  });
});

describe("session read position", () => {
  it("accounts for older pages prepended before the loaded window", () => {
    expect(absoluteMessageIndex(0, 500, 100)).toBe(400);
    expect(absoluteMessageIndex(30, 500, 100)).toBe(430);
    expect(absoluteMessageIndex(30, null, 100)).toBe(30);
  });
});
