import { MemoryRouter, createMemoryHistory } from "@solidjs/router";
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { compatRoutes } from "~/compat/CompatSmoke";
import { routeProbe } from "~/compat/route-probe";

function mount(initialPath = "/_compat") {
  const history = createMemoryHistory();
  history.set({ value: initialPath });
  const utils = render(() => (
    <MemoryRouter history={history}>{compatRoutes}</MemoryRouter>
  ));
  return { ...utils, history };
}

beforeEach(() => routeProbe.reset());

describe("compatibility smoke: Solid compiler + reactivity", () => {
  it("compiles JSX and updates derived state", async () => {
    mount();
    expect(screen.getByTestId("count")).toHaveTextContent("0");
    fireEvent.click(screen.getByRole("button", { name: "Increment" }));
    fireEvent.click(screen.getByRole("button", { name: "Increment" }));
    await waitFor(() =>
      expect(screen.getByTestId("count")).toHaveTextContent("2"),
    );
    expect(screen.getByTestId("doubled")).toHaveTextContent("4");
  });
});

describe("compatibility smoke: Solid Router", () => {
  it("creates and disposes nested route components on navigation", async () => {
    const { history } = mount();
    expect(screen.getByTestId("route-index")).toBeInTheDocument();

    history.set({ value: "/_compat/a" });
    await screen.findByTestId("route-a");
    expect(routeProbe.mounted()).toEqual({ a: 1 });

    history.set({ value: "/_compat/b" });
    await screen.findByTestId("route-b");
    expect(screen.queryByTestId("route-a")).not.toBeInTheDocument();
    expect(routeProbe.disposed()).toEqual({ a: 1 });
    expect(routeProbe.mounted()).toEqual({ a: 1, b: 1 });

    history.set({ value: "/_compat/a" });
    await screen.findByTestId("route-a");
    expect(routeProbe.mounted()).toEqual({ a: 2, b: 1 });
    expect(routeProbe.disposed()).toEqual({ a: 1, b: 1 });
  });

  it("renders a deep-linked nested route directly", async () => {
    mount("/_compat/b");
    await screen.findByTestId("route-b");
    expect(routeProbe.mounted()).toEqual({ b: 1 });
  });

  it("navigates via <A> links relative to the parent route", async () => {
    mount();
    fireEvent.click(screen.getByTestId("link-a"));
    await screen.findByTestId("route-a");
    fireEvent.click(screen.getByTestId("link-b"));
    await screen.findByTestId("route-b");
    expect(routeProbe.disposed()).toEqual({ a: 1 });
  });
});

describe("compatibility smoke: Kobalte Select nested in Dialog", () => {
  it("opens the dialog, picks an option and closes with Escape", async () => {
    mount();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Open dialog" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Pick a fruit");

    // Kobalte opens the listbox on a primary-button mouse pointerdown.
    fireEvent.pointerDown(screen.getByTestId("fruit-trigger"), {
      button: 0,
      pointerType: "mouse",
    });
    const listbox = await screen.findByRole("listbox");
    const options = screen.getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual([
      "Apple",
      "Banana",
      "Cherry",
      "Date",
    ]);
    fireEvent.click(screen.getByRole("option", { name: "Cherry" }));
    await waitFor(() => expect(listbox).not.toBeInTheDocument());
    expect(screen.getByTestId("fruit")).toHaveTextContent("Cherry");
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(screen.getByTestId("fruit")).toHaveTextContent("Cherry");
  });
});

describe("compatibility smoke: input composition", () => {
  it("tracks IME composition and commits the composed value", async () => {
    mount();
    const input = screen.getByTestId<HTMLInputElement>("compose-input");
    expect(screen.getByTestId("composing")).toHaveTextContent("no");

    fireEvent.compositionStart(input);
    await waitFor(() =>
      expect(screen.getByTestId("composing")).toHaveTextContent("yes"),
    );

    input.value = "にほ";
    fireEvent.input(input);
    fireEvent.compositionEnd(input, { data: "日本" });
    input.value = "日本";
    fireEvent.input(input);

    await waitFor(() =>
      expect(screen.getByTestId("composing")).toHaveTextContent("no"),
    );
    expect(screen.getByTestId("compose-value")).toHaveTextContent("日本");
    expect(screen.getByTestId("compose-events")).toHaveTextContent(
      "compositionstart → input → compositionend → input",
    );
  });
});

describe("compatibility smoke: @tanstack/solid-table", () => {
  it("renders headers and five rows with formatted cells", () => {
    mount();
    const table = screen.getByTestId("table");
    expect(table.querySelectorAll("thead th")).toHaveLength(3);
    const rows = table.querySelectorAll("tbody tr");
    expect(rows).toHaveLength(5);
    expect(rows[0]).toHaveTextContent("Keep SQLite");
    expect(rows[0]).toHaveTextContent("92%");
    expect(rows[4]?.getAttribute("data-row-id")).toBe("k-5");
  });
});

describe("compatibility smoke: @tanstack/solid-virtual", () => {
  it("renders only a viewport window of the 10 000 rows", () => {
    // jsdom has no layout; give the scroll container a real viewport
    // (virtual-core measures the scroll element via offsetWidth/offsetHeight).
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(
      function (this: HTMLElement) {
        return this.dataset.testid === "virtual-scroll" ? 240 : 0;
      },
    );
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(
      function (this: HTMLElement) {
        return this.dataset.testid === "virtual-scroll" ? 480 : 0;
      },
    );
    mount();
    const rendered = Number(screen.getByTestId("virtual-rendered").textContent);
    expect(rendered).toBeGreaterThan(0);
    expect(rendered).toBeLessThan(40);
    const rows = screen
      .getByTestId("virtual-scroll")
      .querySelectorAll("[data-virtual-row]");
    expect(rows).toHaveLength(rendered);
    expect(rows[0]?.getAttribute("data-virtual-row")).toBe("0");
  });
});
