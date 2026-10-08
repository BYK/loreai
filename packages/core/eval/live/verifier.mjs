/**
 * Run a host-side checkpoint verifier without letting a failed process spawn
 * leave the matrix waiting forever for an exit event that will never arrive.
 */
export function runVerifierProcess({
  spawn,
  verifier,
  checkpoint,
  scope,
  project,
  image,
  facts,
  timeoutMs = 30000,
}) {
  return new Promise((resolve) => {
    const child = spawn(
      "python3",
      [
        "-",
        "--checkpoint",
        checkpoint,
        "--scope",
        scope,
        "--project",
        project,
        "--agent-image",
        image,
      ],
      {
        env: { ...process.env, LORE_EVAL_FACTS: JSON.stringify(facts) },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let settled = false;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    let stdout = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {}
      settle({ passed: false, error: "verifier timed out" });
    }, timeoutMs);
    child.on("error", (error) => {
      settle({
        passed: false,
        error: `verifier failed to start: ${error.message}`,
      });
    });
    try {
      child.stdin.end(verifier);
    } catch (error) {
      settle({
        passed: false,
        error: `verifier input failed: ${error.message}`,
      });
    }
    child.on("exit", (code) => {
      let detail = null;
      try {
        detail = JSON.parse(stdout.trim());
      } catch {}
      settle({ passed: code === 0, ...(detail || {}) });
    });
  });
}
