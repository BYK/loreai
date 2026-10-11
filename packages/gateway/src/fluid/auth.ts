import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export interface FluidSpikeClaims {
  documentId: string;
  exp: number;
  iat: number;
  scopes: string[];
  tenantId: string;
  user: { id: string; name: string };
  ver: "1.0";
}

export const FLUID_SPIKE_TENANT_ID = "tinylicious";
export const FLUID_SPIKE_SCOPES = [
  "doc:read",
  "doc:write",
  "summary:write",
] as const;

export function createFluidSpikeSecret(): string {
  return randomBytes(32).toString("base64url");
}

export function signFluidSpikeToken(
  claims: Omit<FluidSpikeClaims, "exp" | "iat" | "ver">,
  secret: string,
): string {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(
    JSON.stringify({ alg: "HS256", typ: "JWT" }),
  ).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({ ...claims, iat: now, exp: now + 3600, ver: "1.0" }),
  ).toString("base64url");
  const unsigned = `${header}.${payload}`;
  const signature = createHmac("sha256", secret)
    .update(unsigned)
    .digest("base64url");
  return `${unsigned}.${signature}`;
}

export function verifyFluidSpikeToken(
  token: string,
  secret: string,
  expected: { tenantId: string; documentId?: string },
): FluidSpikeClaims {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Invalid Fluid token");
  const [encodedHeader, encodedClaims, signature] = parts;
  const unsigned = `${encodedHeader}.${encodedClaims}`;
  const expectedSignature = createHmac("sha256", secret)
    .update(unsigned)
    .digest();
  const actualSignature = Buffer.from(signature, "base64url");
  if (
    actualSignature.length !== expectedSignature.length ||
    !timingSafeEqual(actualSignature, expectedSignature)
  ) {
    throw new Error("Invalid Fluid token signature");
  }
  const header = JSON.parse(
    Buffer.from(encodedHeader, "base64url").toString("utf8"),
  ) as { alg?: string; typ?: string };
  const claims = JSON.parse(
    Buffer.from(encodedClaims, "base64url").toString("utf8"),
  ) as FluidSpikeClaims;
  if (
    header.alg !== "HS256" ||
    header.typ !== "JWT" ||
    typeof claims.documentId !== "string" ||
    claims.tenantId !== expected.tenantId ||
    (expected.documentId !== undefined &&
      claims.documentId !== expected.documentId) ||
    typeof claims.user?.id !== "string" ||
    typeof claims.user.name !== "string" ||
    !Array.isArray(claims.scopes) ||
    claims.scopes.some((scope) => typeof scope !== "string") ||
    typeof claims.iat !== "number" ||
    typeof claims.exp !== "number" ||
    !Number.isFinite(claims.exp) ||
    claims.exp <= Math.floor(Date.now() / 1000)
  ) {
    throw new Error("Invalid Fluid token claims");
  }
  return claims;
}
