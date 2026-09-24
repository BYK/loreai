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
  onConfirm: () => void;
  onCancel: () => void;
}> = (props) => (
  <Dialog
    open={props.open}
    onOpenChange={(open) => {
      if (!open && !props.pending) props.onCancel();
    }}
  >
    <DialogContent role="alertdialog" aria-label={props.title}>
      <DialogHeader>
        <DialogTitle>{props.title}</DialogTitle>
        <DialogDescription>{props.description}</DialogDescription>
      </DialogHeader>
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
          disabled={props.pending}
          onClick={props.onConfirm}
        >
          {props.pending ? "Working…" : props.confirmLabel}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
);
