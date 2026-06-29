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

import sys
import types

if "agent.context_engine" not in sys.modules:
    agent_mod = types.ModuleType("agent")
    context_engine_mod = types.ModuleType("agent.context_engine")

    class ContextEngine:
        """Minimal stand-in for the Hermes ContextEngine ABC."""

        def __init__(self, **kwargs):  # noqa: D401 - permissive base
            pass

    context_engine_mod.ContextEngine = ContextEngine
    # Expose the submodule as an attribute so `import agent` + attribute access
    # and `from agent.context_engine import ContextEngine` both resolve.
    agent_mod.context_engine = context_engine_mod
    sys.modules["agent"] = agent_mod
    sys.modules["agent.context_engine"] = context_engine_mod
