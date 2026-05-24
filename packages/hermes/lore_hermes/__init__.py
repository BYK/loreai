"""
Lore plugin for Hermes Agent.

Registers a passthrough context engine (delegates compression to the Lore
gateway), discovers/starts the gateway on session start, injects stable
session identifiers into the conversation, and provides CLI commands for
memory management.

Install:
    pip install lore-hermes

Usage (recommended):
    lore run hermes          # gateway + agent in one command

Usage (standalone):
    hermes                   # plugin discovers/starts gateway automatically
    hermes lore status       # check gateway + project stats
    hermes lore recall ...   # search cross-session memory
"""

import hashlib
import logging
import os
from pathlib import Path

from .engine import LoreContextEngine
from .gateway import ensure_gateway, find_gateway

logger = logging.getLogger(__name__)

# Module-level state, populated by hooks
_session_id: str | None = None
_gateway_url: str | None = None


# ---------------------------------------------------------------------------
# Hooks
# ---------------------------------------------------------------------------


def _derive_session_id(session_id: str | None) -> str:
    """Derive a stable hex session ID.

    Always returns a lowercase hex string (gateway regex requires ``[a-f0-9]{8,64}``).
    When a Hermes session ID is provided, it is hashed to normalize any format
    (UUIDs, nanoids, etc.) into a gateway-compatible hex string.  Falls back to
    a hash of HERMES_HOME + PID for uniqueness within a machine.
    """
    if session_id:
        return hashlib.sha256(session_id.encode()).hexdigest()[:16]
    home = os.environ.get("HERMES_HOME", str(Path.home() / ".hermes"))
    raw = f"{home}:{os.getpid()}"
    return hashlib.sha256(raw.encode()).hexdigest()[:16]


def _on_session_start(session_id: str = "", **kwargs):
    """Discover or start the Lore gateway and configure the provider URL."""
    global _session_id, _gateway_url  # noqa: PLW0603

    _session_id = _derive_session_id(session_id)

    url = ensure_gateway()
    if not url:
        logger.warning("Lore gateway not available — memory features disabled")
        return

    _gateway_url = url

    # Point Hermes's LLM calls at the gateway if not already configured
    # (e.g. when running `hermes` directly without `lore run`).
    # This intentionally mutates os.environ so Hermes's provider resolution
    # picks up the gateway URL on its next API call.
    gateway_base = f"{url}/v1"
    if os.environ.get("OPENAI_BASE_URL") != gateway_base:
        os.environ["OPENAI_BASE_URL"] = gateway_base
        os.environ.setdefault("HERMES_INFERENCE_PROVIDER", "custom")

    # Expose project context for the gateway
    os.environ.setdefault("LORE_PROJECT", os.getcwd())

    logger.info("Lore gateway active at %s (session %s)", url, _session_id)


def _on_pre_llm_call(session_id: str = "", user_message: str = "", **kwargs):
    """Inject session and project identifiers into the conversation context.

    The gateway parses ``[lore:session-id=...]`` and ``[lore:project=...]``
    markers from the user message to reliably identify the session and
    project. This is more robust than the fingerprint-based fallback
    (tier 3) used when no explicit headers are available.
    """
    if not _gateway_url:
        return None

    sid = _session_id or _derive_session_id(session_id)
    cwd = os.getcwd()

    parts: list[str] = []
    if sid:
        parts.append(f"[lore:session-id={sid}]")
    parts.append(f"[lore:project={cwd}]")

    return {"context": "\n".join(parts)}


# ---------------------------------------------------------------------------
# CLI: hermes lore <status|recall>
# ---------------------------------------------------------------------------


def _setup_cli(subparser):
    """Build the argparse tree for ``hermes lore`` subcommands."""
    subs = subparser.add_subparsers(dest="lore_command")

    subs.add_parser("status", help="Show Lore gateway status and memory stats")

    recall_p = subs.add_parser("recall", help="Search Lore memory")
    recall_p.add_argument("query", nargs="+", help="Search query")
    recall_p.add_argument(
        "--scope",
        default="all",
        choices=["all", "session", "project", "knowledge"],
        help="Search scope (default: all)",
    )
    recall_p.add_argument(
        "--limit",
        type=int,
        default=10,
        help="Maximum number of results (default: 10)",
    )

    subparser.set_defaults(func=_handle_cli)


def _handle_cli(args):
    """Dispatch ``hermes lore`` subcommands."""
    cmd = getattr(args, "lore_command", None)
    if cmd == "status":
        _cmd_status()
    elif cmd == "recall":
        _cmd_recall(args)
    else:
        print("Usage: hermes lore <status|recall>")


def _cmd_status():
    """Show Lore gateway connection status and project statistics."""
    import httpx

    url = find_gateway()
    if not url:
        print("Lore gateway: NOT RUNNING")
        print("Start with: lore start")
        print("  or: lore run hermes")
        return

    try:
        resp = httpx.get(f"{url}/health", timeout=5)
        data = resp.json()
        print(f"Lore gateway: RUNNING at {url}")
        print(f"Version: {data.get('version', 'unknown')}")
    except Exception as e:
        print(f"Lore gateway: ERROR ({e})")
        return

    # Project stats
    cwd = os.getcwd()
    try:
        resp = httpx.get(f"{url}/api/v1/projects", timeout=5)
        if resp.status_code == 200:
            projects = resp.json()
            # Find the project matching cwd
            project = None
            for p in projects:
                if p.get("path") == cwd:
                    project = p
                    break

            if project:
                print(f"\nProject: {project.get('name', cwd)}")
                print(f"  Knowledge entries: {project.get('knowledge_count', 0)}")
                print(f"  Sessions: {project.get('session_count', 0)}")
                print(f"  Messages stored: {project.get('message_count', 0)}")
            else:
                print(f"\nNo Lore data for {cwd} yet.")
                print("Start a conversation to begin building memory.")
    except Exception:
        pass  # Stats are best-effort


def _cmd_recall(args):
    """Search Lore memory from the command line."""
    import httpx

    url = find_gateway()
    if not url:
        print("Lore gateway not running. Start with: lore start")
        return

    query = " ".join(args.query)
    try:
        resp = httpx.get(
            f"{url}/api/v1/recall",
            params={
                "q": query,
                "path": os.getcwd(),
                "scope": args.scope,
                "limit": args.limit,
            },
            timeout=30,
        )

        if resp.status_code != 200:
            print(f"Recall failed: {resp.text}")
            return

        data = resp.json()
        result = data.get("result", "")
        if result:
            print(result if isinstance(result, str) else str(result))
        else:
            print("No results found.")
    except httpx.TimeoutException:
        print("Recall timed out — try a more specific query.")
    except Exception as e:
        print(f"Recall error: {e}")


# ---------------------------------------------------------------------------
# Plugin entry point
# ---------------------------------------------------------------------------


def register(ctx):
    """Hermes plugin entry point.

    Registers:
    - Context engine: passthrough that delegates compression to the gateway
    - on_session_start hook: gateway discovery/startup + provider URL config
    - pre_llm_call hook: session/project identifier injection
    - CLI commands: hermes lore <status|recall>
    """
    # 1. Context engine — disable Hermes's built-in compressor
    ctx.register_context_engine(LoreContextEngine())

    # 2. Hooks — gateway lifecycle + session ID injection
    ctx.register_hook("on_session_start", _on_session_start)
    ctx.register_hook("pre_llm_call", _on_pre_llm_call)

    # 3. CLI — hermes lore <status|recall>
    ctx.register_cli_command(
        name="lore",
        help="Lore memory management",
        setup_fn=_setup_cli,
        handler_fn=_handle_cli,
    )
