import type { Component, JSX, ParentComponent } from "solid-js";
import { For, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { A, type RouteDefinition, useLocation } from "@solidjs/router";
import {
  createColumnHelper,
  createTable,
  tableFeatures,
} from "@tanstack/solid-table";
import { createVirtualizer } from "@tanstack/solid-virtual";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "~/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Separator } from "~/components/ui/separator";
import {
  TextField,
  TextFieldInput,
  TextFieldLabel,
} from "~/components/ui/text-field";
import { routeProbe } from "./route-probe";

/**
 * Compatibility smoke page (UI-01, issue #1796).
 *
 * Exercises every dependency of the chosen stack in one place so that
 * `vite build`, `tsc` and the jsdom unit tests prove the set works together:
 * Solid compiler/plugin, Solid Router route creation and disposal, a Kobalte
 * Select nested inside a Kobalte Dialog, IME input composition, a small
 * TanStack table, TanStack virtual rows, and Tailwind 4 utilities mapped onto
 * the Lore tokens. It is not a product screen.
 */

const Probe: ParentComponent<{ id: string; title: string }> = (props) => (
  <section
    data-probe={props.id}
    class="rounded-lg border border-line bg-surface p-4 shadow-xs"
  >
    <h2 class="mb-3 text-sm font-semibold text-text">{props.title}</h2>
    {props.children}
  </section>
);

const CounterProbe: Component = () => {
  const [count, setCount] = createSignal(0);
  const doubled = createMemo(() => count() * 2);
  return (
    <Probe id="reactivity" title="Solid compiler + reactivity">
      <div class="flex items-center gap-3 text-sm">
        <Button size="sm" onClick={() => setCount((c) => c + 1)}>
          Increment
        </Button>
        <span>
          count=<output data-testid="count">{count()}</output> doubled=
          <output data-testid="doubled">{doubled()}</output>
        </span>
      </div>
    </Probe>
  );
};

export function probeRoute(name: string): Component {
  return () => {
    onMount(() => routeProbe.recordMount(name));
    onCleanup(() => routeProbe.recordDispose(name));
    return (
      <p data-testid={`route-${name}`} class="text-sm">
        Route <b>{name}</b> is mounted.
      </p>
    );
  };
}

const RouterProbe: ParentComponent = (props) => {
  const location = useLocation();
  const counts = (): string =>
    Object.entries(routeProbe.mounted())
      .map(
        ([name, n]) =>
          `${name}: mounted ${n}, disposed ${routeProbe.disposed()[name] ?? 0}`,
      )
      .join("; ") || "none yet";
  return (
    <Probe id="router" title="Solid Router: nested route create/dispose">
      <nav class="mb-2 flex gap-2 text-sm">
        <A href="a" class="underline" data-testid="link-a">
          Route A
        </A>
        <A href="b" class="underline" data-testid="link-b">
          Route B
        </A>
        <A href="." class="underline" data-testid="link-index" end>
          Index
        </A>
      </nav>
      <div class="rounded-md bg-shade p-3">{props.children}</div>
      <p class="mt-2 text-xs text-muted">
        path={location.pathname} ·{" "}
        <span data-testid="route-counts">{counts()}</span>
      </p>
    </Probe>
  );
};

const FRUITS = ["Apple", "Banana", "Cherry", "Date"] as const;

const NestedDialogProbe: Component = () => {
  const [fruit, setFruit] = createSignal<string | null>(null);
  const [open, setOpen] = createSignal(false);
  return (
    <Probe id="dialog-select" title="Kobalte: Select nested in Dialog">
      <Dialog open={open()} onOpenChange={setOpen}>
        <DialogTrigger as={Button} variant="outline" size="sm">
          Open dialog
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Pick a fruit</DialogTitle>
            <DialogDescription>
              The select below renders in its own portal above the dialog.
            </DialogDescription>
          </DialogHeader>
          <Select
            value={fruit()}
            onChange={setFruit}
            options={[...FRUITS]}
            placeholder="Choose…"
            itemComponent={(props) => (
              <SelectItem item={props.item}>{props.item.rawValue}</SelectItem>
            )}
          >
            <SelectTrigger aria-label="Fruit" data-testid="fruit-trigger">
              <SelectValue<string>>
                {(state) => state.selectedOption()}
              </SelectValue>
            </SelectTrigger>
            <SelectContent />
          </Select>
        </DialogContent>
      </Dialog>
      <p class="mt-2 text-sm">
        selected=<output data-testid="fruit">{fruit() ?? "none"}</output>
      </p>
    </Probe>
  );
};

const CompositionProbe: Component = () => {
  const [value, setValue] = createSignal("");
  const [composing, setComposing] = createSignal(false);
  const [events, setEvents] = createSignal<string[]>([]);
  const log = (name: string): void => {
    setEvents((prev) => [...prev, name].slice(-6));
  };
  return (
    <Probe id="composition" title="Input composition (IME)">
      <TextField value={value()} onChange={setValue} class="max-w-xs">
        <TextFieldLabel>Type or compose</TextFieldLabel>
        <TextFieldInput
          data-testid="compose-input"
          onCompositionStart={() => {
            setComposing(true);
            log("compositionstart");
          }}
          onCompositionEnd={() => {
            setComposing(false);
            log("compositionend");
          }}
          onInput={() => log("input")}
        />
      </TextField>
      <p class="mt-2 text-sm">
        value=<output data-testid="compose-value">{value()}</output> composing=
        <output data-testid="composing">{composing() ? "yes" : "no"}</output>
      </p>
      <p class="text-xs text-muted" data-testid="compose-events">
        {events().join(" → ") || "no events yet"}
      </p>
    </Probe>
  );
};

type Row = { id: string; title: string; category: string; confidence: number };

const TABLE_ROWS: Row[] = [
  { id: "k-1", title: "Keep SQLite", category: "decision", confidence: 0.92 },
  {
    id: "k-2",
    title: "WAL mode on",
    category: "architecture",
    confidence: 0.88,
  },
  { id: "k-3", title: "FTS5 for recall", category: "pattern", confidence: 0.8 },
  {
    id: "k-4",
    title: "No cloud dependency",
    category: "preference",
    confidence: 0.97,
  },
  {
    id: "k-5",
    title: "Tests use temp DB",
    category: "gotcha",
    confidence: 0.75,
  },
];

const features = tableFeatures({});
const helper = createColumnHelper<typeof features, Row>();
const columns = helper.columns([
  helper.accessor("title", { header: "Title" }),
  helper.accessor("category", { header: "Category" }),
  helper.accessor("confidence", {
    header: "Confidence",
    cell: (ctx) => `${Math.round(ctx.getValue() * 100)}%`,
  }),
]);

const TableProbe: Component = () => {
  const table = createTable({
    features,
    columns,
    get data() {
      return TABLE_ROWS;
    },
  });
  return (
    <Probe id="table" title="@tanstack/solid-table (5 rows)">
      <table class="w-full border-collapse text-sm" data-testid="table">
        <thead>
          <For each={table.getHeaderGroups()}>
            {(group) => (
              <tr>
                <For each={group.headers}>
                  {(header) => (
                    <th class="border-b border-line px-2 py-1 text-left text-xs font-semibold text-muted">
                      <table.FlexRender header={header} />
                    </th>
                  )}
                </For>
              </tr>
            )}
          </For>
        </thead>
        <tbody>
          <For each={table.getRowModel().rows}>
            {(row) => (
              <tr data-row-id={row.original.id}>
                <For each={row.getAllCells()}>
                  {(cell) => (
                    <td class="border-b border-line px-2 py-1">
                      <table.FlexRender cell={cell} />
                    </td>
                  )}
                </For>
              </tr>
            )}
          </For>
        </tbody>
      </table>
    </Probe>
  );
};

const VIRTUAL_TOTAL = 10_000;
const VIRTUAL_ROW_PX = 28;

const VirtualProbe: Component = () => {
  let scrollEl: HTMLDivElement | null = null;
  const virtualizer = createVirtualizer({
    count: VIRTUAL_TOTAL,
    getScrollElement: () => scrollEl,
    estimateSize: () => VIRTUAL_ROW_PX,
    overscan: 4,
  });
  const items = (): ReturnType<typeof virtualizer.getVirtualItems> =>
    virtualizer.getVirtualItems();
  return (
    <Probe
      id="virtual"
      title={`@tanstack/solid-virtual (${VIRTUAL_TOTAL} rows)`}
    >
      <div
        ref={(el) => {
          scrollEl = el;
        }}
        data-testid="virtual-scroll"
        class="h-60 overflow-auto rounded-md border border-line bg-shade text-sm"
      >
        <div
          style={{
            height: `${virtualizer.getTotalSize()}px`,
            position: "relative",
          }}
        >
          <For each={items()}>
            {(item) => (
              <div
                data-virtual-row={item.index}
                class="absolute left-0 flex w-full items-center border-b border-line/60 px-3"
                style={{
                  height: `${item.size}px`,
                  transform: `translateY(${item.start}px)`,
                }}
              >
                Row {item.index + 1}
              </div>
            )}
          </For>
        </div>
      </div>
      <p class="mt-2 text-xs text-muted">
        rendered{" "}
        <output data-testid="virtual-rendered">{items().length}</output> of{" "}
        {VIRTUAL_TOTAL}
      </p>
    </Probe>
  );
};

const TOKEN_SWATCHES: ReadonlyArray<{ token: string; class: string }> = [
  { token: "bg", class: "bg-bg" },
  { token: "surface", class: "bg-surface" },
  { token: "chrome", class: "bg-chrome" },
  { token: "soft", class: "bg-soft" },
  { token: "shade", class: "bg-shade" },
  { token: "nav", class: "bg-nav" },
  { token: "mark", class: "bg-mark" },
  { token: "accent-soft", class: "bg-accent-soft text-accent-soft-text" },
];

const TailwindProbe: Component = () => (
  <Probe id="tailwind" title="Tailwind 4 utilities on Lore tokens">
    <div class="flex flex-wrap items-center gap-2">
      <Badge>outline</Badge>
      <Badge variant="teal">teal</Badge>
      <Badge variant="gold">gold</Badge>
      <Badge variant="danger">danger</Badge>
      <Badge variant="default">primary</Badge>
      <span class="passage-target text-sm">highlighted passage</span>
    </div>
    <Separator class="my-3" />
    <div class="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
      <For each={TOKEN_SWATCHES}>
        {(swatch) => (
          <div
            class={`rounded-md border border-line p-2 ${swatch.class}`}
            data-token={swatch.token}
          >
            {swatch.token}
          </div>
        )}
      </For>
    </div>
  </Probe>
);

/** Layout for the compatibility smoke page; nested routes render via children. */
export const CompatSmoke: ParentComponent = (props): JSX.Element => (
  <main class="mx-auto flex max-w-3xl flex-col gap-4 p-6">
    <header class="flex flex-wrap items-center gap-3">
      <h1 class="text-xl font-semibold tracking-tight">Compatibility smoke</h1>
      <Badge variant="gold">not a product screen</Badge>
      <p class="w-full text-sm text-muted">
        Solid 1.9 + Solid Router 1.0 + Kobalte 0.13 + TanStack table 9 / virtual
        3 + Tailwind 4 (UI-01, #1796).
      </p>
    </header>
    <CounterProbe />
    <RouterProbe>{props.children}</RouterProbe>
    <NestedDialogProbe />
    <CompositionProbe />
    <TableProbe />
    <VirtualProbe />
    <TailwindProbe />
  </main>
);

export const RouteIndex: Component = () => (
  <p data-testid="route-index" class="text-sm text-muted">
    No probe route selected.
  </p>
);

/** Route tree for the smoke page; mount under any base path. */
export const compatRoutes: RouteDefinition = {
  path: "/_compat",
  component: CompatSmoke,
  children: [
    { path: "/", component: RouteIndex },
    { path: "/a", component: probeRoute("a") },
    { path: "/b", component: probeRoute("b") },
  ],
};
