"""
Lore context engine — passthrough that delegates compression to the gateway.

The Lore gateway's gradient context manager handles 4-layer progressive
compression transparently. This engine disables Hermes's built-in
ContextCompressor so messages are sent to the gateway uncompressed,
letting the gateway make optimal compression decisions with full
visibility into distillation state and cache economics.
"""

from agent.context_engine import ContextEngine


class LoreContextEngine(ContextEngine):
    """Passthrough context engine — never compresses locally."""

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.last_prompt_tokens: int = 0
        self.last_completion_tokens: int = 0
        self.last_total_tokens: int = 0

    @property
    def name(self) -> str:
        return "lore"

    def update_from_response(self, usage: dict) -> None:
        """Track token counts from API responses for display/logging."""
        self.last_prompt_tokens = usage.get("prompt_tokens", 0)
        self.last_completion_tokens = usage.get("completion_tokens", 0)
        self.last_total_tokens = self.last_prompt_tokens + self.last_completion_tokens

    def should_compress(self, prompt_tokens: int = None) -> bool:
        """Never compress — the Lore gateway handles it."""
        return False

    def should_compress_preflight(self, messages: list) -> bool:
        """Never compress — the Lore gateway handles it."""
        return False

    def compress(
        self,
        messages: list,
        current_tokens: int = None,
        focus_topic: str = None,
    ) -> list:
        """Return messages unmodified. Should never be called since
        should_compress always returns False, but acts as a safety net."""
        return messages

    def get_status(self) -> dict:
        """Return status dict for display."""
        return {
            "engine": "lore",
            "compression_delegated": True,
            "prompt_tokens": self.last_prompt_tokens,
            "completion_tokens": self.last_completion_tokens,
            "total_tokens": self.last_total_tokens,
            "compression_count": 0,
            "note": "Compression handled by Lore gateway gradient context manager",
        }
