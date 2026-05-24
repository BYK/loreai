"""
Lore gateway discovery and startup.

Probes for a running Lore gateway on known ports, or starts one if the
``lore`` binary is available on PATH.
"""

import logging
import os
import shutil
import subprocess
import time

logger = logging.getLogger(__name__)

DEFAULT_PORTS = [3207, 5673]
HEALTH_TIMEOUT = 2.0
STARTUP_POLL_INTERVAL = 0.5
STARTUP_MAX_WAIT = 10.0


def _probe(url: str) -> bool:
    """Check if a Lore gateway is alive at *url*."""
    try:
        import httpx

        resp = httpx.get(f"{url}/health", timeout=HEALTH_TIMEOUT)
        return resp.status_code == 200
    except Exception:
        return False


def find_gateway() -> str | None:
    """Probe for a running Lore gateway. Returns the base URL or ``None``."""
    # 1. Explicit remote URL (hosted / tunnelled gateway)
    remote = os.environ.get("LORE_REMOTE_URL")
    if remote and _probe(remote):
        return remote

    # 2. Explicit gateway URL (set by lore run / lore start)
    gateway = os.environ.get("LORE_GATEWAY_URL")
    if gateway and _probe(gateway):
        return gateway

    # 3. Default local ports
    for port in DEFAULT_PORTS:
        url = f"http://127.0.0.1:{port}"
        if _probe(url):
            return url

    return None


def ensure_gateway() -> str | None:
    """Find or start the Lore gateway. Returns the base URL or ``None``."""
    url = find_gateway()
    if url:
        return url

    # Try to start the gateway via the lore binary
    lore_bin = shutil.which("lore") or shutil.which("lore-gateway")
    if not lore_bin:
        logger.warning(
            "Lore binary not found on PATH. "
            "Install from https://withlore.ai or run: "
            "curl -fsSL https://withlore.ai/install | bash"
        )
        return None

    try:
        proc = subprocess.Popen(
            [lore_bin, "start"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )

        # Poll until the gateway responds (max STARTUP_MAX_WAIT seconds)
        elapsed = 0.0
        while elapsed < STARTUP_MAX_WAIT:
            time.sleep(STARTUP_POLL_INTERVAL)
            elapsed += STARTUP_POLL_INTERVAL
            url = find_gateway()
            if url:
                logger.info(
                    "Lore gateway started at %s (pid %d)", url, proc.pid
                )
                return url

        # Gateway didn't respond in time — kill the orphaned process.
        logger.warning(
            "Lore gateway process started (pid %d) but not responding "
            "after %.0fs — terminating",
            proc.pid,
            STARTUP_MAX_WAIT,
        )
        proc.terminate()
        try:
            proc.wait(timeout=3)
        except subprocess.TimeoutExpired:
            proc.kill()
    except Exception as e:
        logger.warning("Failed to start Lore gateway: %s", e)

    return None
