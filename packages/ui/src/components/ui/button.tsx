// Copied from Solid UI (MIT) — see ATTRIBUTION.md in this directory.
import type { JSX, ValidComponent } from "solid-js";
import { splitProps } from "solid-js";

import * as ButtonPrimitive from "@kobalte/core/button";
import type { PolymorphicProps } from "@kobalte/core/polymorphic";
import type { VariantProps } from "class-variance-authority";
import { cva } from "class-variance-authority";

import { Icon, type IconName } from "~/components/shell/Icon";
import { cn } from "~/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary-hover",
        destructive:
          "bg-destructive text-destructive-foreground hover:bg-destructive/90",
        outline:
          "border border-input bg-surface text-text hover:bg-soft hover:text-text",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        ghost: "hover:bg-soft hover:text-text",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-10 px-4 py-2",
        sm: "h-9 px-3 text-xs",
        lg: "h-11 px-8",
        icon: "size-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

type ButtonProps<T extends ValidComponent = "button"> =
  ButtonPrimitive.ButtonRootProps<T> &
    VariantProps<typeof buttonVariants> & {
      class?: string | undefined;
      children?: JSX.Element;
      /** Pending is presentational; the caller owns the operation and receipt. */
      pending?: boolean;
      "aria-busy"?: JSX.AriaAttributes["aria-busy"];
      icon?: IconName;
    };

const Button = <T extends ValidComponent = "button">(
  props: PolymorphicProps<T, ButtonProps<T>>,
) => {
  const [local, others] = splitProps(props as ButtonProps, [
    "variant",
    "size",
    "class",
    "children",
    "pending",
    "icon",
    "disabled",
    "aria-busy",
  ]);
  return (
    <ButtonPrimitive.Root
      class={cn(
        buttonVariants({ variant: local.variant, size: local.size }),
        local.class,
      )}
      {...others}
      disabled={local.pending || local.disabled}
      aria-busy={local.pending || local["aria-busy"]}
    >
      {(local.pending || local.icon) && (
        <Icon
          name={local.pending ? "loading" : local.icon!}
          class={local.pending ? "motion-safe:animate-spin" : undefined}
        />
      )}
      {local.children}
    </ButtonPrimitive.Root>
  );
};

export { Button, buttonVariants };
export type { ButtonProps };
