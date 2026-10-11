const variant = new URLSearchParams(location.search).get("variant");
if (variant === "yjs") await import("./browser-yjs");
else if (variant === "automerge") await import("./browser-automerge");
else if (variant === "nocrdt") await import("./browser-nocrdt");
else throw new Error(`Unknown comparison variant: ${variant}`);

export {};
