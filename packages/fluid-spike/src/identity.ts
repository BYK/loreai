type TokenResponse = { jwt: string; fromCache: boolean };

export function identityTokenProvider(
  id: string,
  name = id,
  gatewayBaseUrl = "http://127.0.0.1:7070",
) {
  const fetchToken = async (documentId = ""): Promise<TokenResponse> => {
    const response = await fetch(`${gatewayBaseUrl}/fluid-spike/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ documentId, participant: id, name }),
    });
    if (!response.ok) {
      throw new Error(`Fluid token request denied (${response.status})`);
    }
    const result = (await response.json()) as { jwt?: string };
    if (typeof result.jwt !== "string") {
      throw new Error("Fluid token endpoint returned no JWT");
    }
    return { jwt: result.jwt, fromCache: false };
  };
  return {
    fetchOrdererToken: async (_tenantId: string, documentId?: string) =>
      fetchToken(documentId ?? ""),
    fetchStorageToken: async (_tenantId: string, documentId: string) =>
      fetchToken(documentId),
  };
}
