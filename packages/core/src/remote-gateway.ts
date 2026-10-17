/** Normalize gateway base URLs for remote/local ownership decisions. */
function normalizeGatewayBase(value: string): string | null {
  try {
    const url = new URL(value);
    url.hash = "";
    return url.href.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

/**
 * Whether the resolved target is the explicitly configured remote gateway.
 * Native recall must stay disabled on this path so a host tool cannot silently
 * query its local database while provider traffic is routed to the remote one.
 */
export function isRemoteGatewayTarget(
  gatewayBase: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const remoteUrl = env.LORE_REMOTE_URL;
  if (!remoteUrl) return false;
  const normalizedRemote = normalizeGatewayBase(remoteUrl);
  return (
    normalizedRemote !== null &&
    normalizedRemote === normalizeGatewayBase(gatewayBase)
  );
}
