export function waitForAgentProcess(p, timeoutMs) {
  return new Promise((resolve) => {
    let timedOut = false;
    let settled = false;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        p.kill("SIGKILL");
      } catch {}
    }, timeoutMs);
    p.once("error", () => settle({ code: 1, timedOut: false }));
    p.once("exit", (code) => settle({ code: code ?? 1, timedOut }));
  });
}
