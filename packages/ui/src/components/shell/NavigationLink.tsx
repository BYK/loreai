import type { Component, JSX } from "solid-js";
import { splitProps } from "solid-js";
import { useHref, useResolvedPath } from "@solidjs/router";

/** Base-aware router link with explicit current state (including query scopes).
 * Router A computes aria-current from pathname alone and overrides callers.
 * Native links keep router interception, modifier clicks and context menus.
 */
export const NavigationLink: Component<
  Omit<JSX.AnchorHTMLAttributes<HTMLAnchorElement>, "href"> & {
    href: string;
    current?: boolean;
  }
> = (props) => {
  const [, rest] = splitProps(props, ["href", "current"]);
  const path = useResolvedPath(() => props.href);
  const href = useHref(path);
  return (
    <a
      {...rest}
      href={href() ?? props.href}
      link
      aria-current={props.current ? "page" : undefined}
    />
  );
};
