"""Pytest configuration for the lore-hermes test suite.

`lore_hermes.engine.LoreContextEngine` subclasses Hermes's
`agent.context_engine.ContextEngine`, which is an external Hermes dependency
that is NOT vendored in this monorepo. Importing `lore_hermes` (its
`__init__.py` eagerly imports the engine) therefore fails with
`ModuleNotFoundError: No module named 'agent'` outside a full Hermes install.

We inject a minimal stub of the `agent.context_engine` module into
`sys.modules` before any test imports `lore_hermes`, so the plugin's own logic
(passthrough engine, gateway discovery, session-id derivation) can be unit
tested in isolation. This is test-only scaffolding — production runs against
the real Hermes `ContextEngine`.
"""

import abc
import sys
import types

if "agent.context_engine" not in sys.modules:
    agent_mod = types.ModuleType("agent")
    context_engine_mod = types.ModuleType("agent.context_engine")

    class ContextEngine(abc.ABC):
        """Minimal stand-in for the Hermes ``ContextEngine`` ABC.

        The real base lives in the external ``hermes-agent`` package, which is
        NOT vendored here. This stub is an ``abc.ABC`` that mirrors the real
        ABC's *abstract-method set* so a missing or renamed override in
        ``lore_hermes.engine.LoreContextEngine`` is caught at instantiation
        (``TypeError: Can't instantiate abstract class ...``) instead of
        silently passing — a plain-class stub would hide exactly that bug
        (#1042, follow-up to the #1040 review).

        The abstract set below is a snapshot of
        ``hermes-agent==0.18.0``'s ``ContextEngine.__abstractmethods__``:
        ``{name, should_compress, compress, update_from_response}``. Concrete
        upstream hooks (e.g. ``should_compress_preflight``, ``get_status``) are
        NOT abstract there, so they are intentionally omitted — marking them
        abstract would make this stub *stricter* than reality.

        Drift caveat: this is hand-maintained. Upstream Hermes adding a *new*
        abstract method is only caught by the real-Hermes integration path
        (``packages/hermes/test-integration.sh``), not by this unit suite.
        """

        def __init__(self, **kwargs):  # concrete upstream — permissive base
            pass

        @property
        @abc.abstractmethod
        def name(self) -> str:  # noqa: D401
            ...

        @abc.abstractmethod
        def should_compress(self, prompt_tokens: int = None) -> bool:
            ...

        @abc.abstractmethod
        def compress(
            self,
            messages: list,
            current_tokens: int = None,
            focus_topic: str = None,
        ) -> list:
            ...

        @abc.abstractmethod
        def update_from_response(self, usage: dict) -> None:
            ...

    context_engine_mod.ContextEngine = ContextEngine
    # Expose the submodule as an attribute so `import agent` + attribute access
    # and `from agent.context_engine import ContextEngine` both resolve.
    agent_mod.context_engine = context_engine_mod
    sys.modules["agent"] = agent_mod
    sys.modules["agent.context_engine"] = context_engine_mod
