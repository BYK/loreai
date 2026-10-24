// Owned Solid UI/shadcn-style resize handle; native pointer and keyboard input.
import type { Component } from "solid-js";

export const ResizableHandle: Component<{
  label?: string;
  value: number;
  onChange: (width: number) => void;
}> = (props) => {
  let drag: { x: number; width: number } | undefined;
  return (
    <div
      role="separator"
      aria-label={props.label ?? "Resize knowledge list"}
      aria-orientation="vertical"
      aria-valuemin={260}
      aria-valuemax={480}
      aria-valuenow={props.value}
      tabIndex={0}
      title="Drag to resize · Arrow keys adjust · Double-click to reset"
      class="h-full group relative z-10 hidden cursor-col-resize touch-none items-center justify-center border-x border-line bg-bg outline-none hover:bg-soft focus-visible:bg-accent-soft focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring md:flex"
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        drag = { x: event.clientX, width: props.value };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (drag) props.onChange(drag.width + event.clientX - drag.x);
      }}
      onPointerUp={() => {
        drag = undefined;
      }}
      onLostPointerCapture={() => {
        drag = undefined;
      }}
      onDblClick={() => props.onChange(320)}
      onKeyDown={(event) => {
        const next =
          event.key === "ArrowLeft"
            ? props.value - 16
            : event.key === "ArrowRight"
              ? props.value + 16
              : event.key === "Home"
                ? 260
                : event.key === "End"
                  ? 480
                  : undefined;
        if (next !== undefined) {
          event.preventDefault();
          props.onChange(next);
        }
      }}
    >
      <span
        aria-hidden="true"
        class="h-8 w-0.5 rounded-full bg-line group-hover:bg-accent"
      />
    </div>
  );
};
