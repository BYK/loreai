# Copilot action runtime

Lore already supports GitHub Copilot's Chat Completions and Responses wire
formats. This directory does not add another model transport. It installs the
official Copilot runtime used only when the composite action receives an
Actions `GITHUB_TOKEN` through its `github-token` input.

## Why the runtime is required

Lore's direct `github-copilot` provider works with a bearer credential already
accepted by the Copilot model API, such as the user OAuth credential stored by
OpenCode. An Actions `GITHUB_TOKEN` is instead a short-lived GitHub App
installation token. The `copilot-requests: write` permission authorizes Copilot
use through supported GitHub tooling, but does not make the installation token
a supported bearer credential for direct requests to `api.githubcopilot.com`.

This distinction was verified in CI before PR #1649: forwarding the installation
token directly to the corrected `/responses` request returned HTTP 400 for every
judge call, while the official runtime completed the same workload. The runtime
owns GitHub's authentication, entitlement, policy, endpoint-selection, and
billing-attribution behavior for that token class.

The responsibilities are therefore split deliberately:

- Lore owns candidate selection, prompts, model routing, timeouts, retries,
  verdict parsing, and reports.
- `@github/copilot` owns the supported Copilot runtime and Actions-token flow.
- `@github/copilot-sdk` provides typed JSON-RPC control of that runtime, including
  isolated sessions, an exact replacement system prompt, disabled tools and
  repository configuration, cancellation, and bounded cleanup.
- `copilot-proxy.mjs` is a loopback-only adapter between Lore's worker request
  and an SDK session. The action token is never forwarded by Lore to the model
  endpoint.

Calling `copilot -p` directly would still require the runtime while losing the
session controls above. Implementing its private JSON-RPC or authentication flow
inside Lore would duplicate the SDK or rely on an unsupported GitHub contract.

## Why this is a separate package

A composite action cannot declare npm dependencies. The private `package.json`
and `package-lock.json` let the action run `npm ci` with exact versions and
integrity hashes. Keeping these dependencies here also avoids shipping a large,
platform-specific Copilot CLI binary with every Lore installation when only the
zero-secret CI path needs it.

The explicit `@github/copilot` pin fixes the runtime version instead of relying
on the SDK's compatible transitive range. `@github/copilot-sdk` supplies the
client API; it also expects the CLI runtime to be available.

## When it can be removed

Remove this runtime only if one of these contracts changes:

1. The action requires callers to provide a bearer credential already accepted
   by the Copilot model API and gives up the zero-secret `github.token` path.
2. GitHub publishes and supports a direct Actions installation-token API flow
   that Lore can implement without copying private CLI behavior.

Do not replace the runtime by forwarding `github.token` directly or by
reverse-engineering the CLI's private authentication and billing exchange.

## Model support

The official SDK supports every model available in Copilot CLI. Any model
allowlist in `action.yml` or `copilot-proxy.mjs` is a Lore bridge implementation
constraint, not an SDK limitation and not evidence that other models are absent
from Copilot. The proxy's local HTTP envelope is likewise independent of the
wire API the runtime ultimately uses for a selected model.
