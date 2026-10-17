import type { Component, JSX } from "solid-js";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./dialog";
import { Button } from "./button";

/**
 * Generic confirmation dialog over the Kobalte dialog primitive — used for
 * destructive or expensive actions (entity delete, rebuild-all, and later the
 * project actions). `role="alertdialog"` and the Kobalte focus trap keep it
 * keyboard reachable; Escape/backdrop close calls `onCancel`.
 */
export const ConfirmDialog: Component<{
  open: boolean;
  title: string;
  /** Body copy; name the target and the consequence. */
  description: JSX.Element;
  confirmLabel: string;
  destructive?: boolean;
  /** Disable both buttons while the action is in flight. */
  pending?: boolean;
  /** Additional caller-owned validation; cancellation remains available. */
  confirmDisabled?: boolean;
  pendingLabel?: string;
  contentTestId?: string;
  confirmTestId?: string;
  /** Rendered between the description and the buttons (e.g. an inline error notice). */
  children?: JSX.Element;
  onConfirm: () => void;
  onCancel: () => void;
}> = (props) => (
  <Dialog
    open={props.open}
    onOpenChange={(open) => {
      if (!open && !props.pending) props.onCancel();
    }}
  >
    <DialogContent
      role="alertdialog"
      aria-label={props.title}
      data-testid={props.contentTestId}
    >
      <DialogHeader>
        <DialogTitle>{props.title}</DialogTitle>
        <DialogDescription>{props.description}</DialogDescription>
      </DialogHeader>
      {props.children}
      <DialogFooter>
        <Button
          variant="outline"
          disabled={props.pending}
          onClick={props.onCancel}
        >
          Cancel
        </Button>
        <Button
          variant={props.destructive ? "destructive" : "default"}
          disabled={props.pending || props.confirmDisabled}
          data-testid={props.confirmTestId}
          onClick={props.onConfirm}
        >
          {props.pending
            ? (props.pendingLabel ?? "Working…")
            : props.confirmLabel}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
);
