/**
 * AWS SigV4 request signing for Bedrock upstream calls.
 *
 * Uses @smithy/signature-v4 for SigV4 signing and @aws-sdk/credential-providers
 * for the standard AWS credential provider chain (env vars, ~/.aws/credentials,
 * IAM role, ECS task role).
 *
 * Credentials are resolved lazily on first Bedrock request and cached.
 * The credential provider chain handles refresh automatically (e.g. IMDS
 * token refresh for EC2 IAM roles).
 */
import { SignatureV4 } from "@smithy/signature-v4";
import { Sha256 } from "@aws-crypto/sha256-js";
import { HttpRequest } from "@smithy/protocol-http";
import {
  fromEnv,
  fromIni,
  fromContainerMetadata,
  fromInstanceMetadata,
} from "@aws-sdk/credential-providers";
import type { AwsCredentialIdentity } from "@smithy/types";

// ---------------------------------------------------------------------------
// Credential provider chain
// ---------------------------------------------------------------------------

/**
 * AWS credential provider chain (lazy-loaded to avoid importing AWS SDK
 * on gateway startup unless Bedrock is actually used).
 *
 * Resolution order (standard AWS chain):
 *  1. Environment variables (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN)
 *  2. Shared credentials file (~/.aws/credentials) with optional profile
 *  3. ECS task role credentials (AWS_CONTAINER_CREDENTIALS_RELATIVE_URI)
 *  4. EC2 IMDS instance metadata (IAM role)
 */
type CredentialProvider = () => Promise<AwsCredentialIdentity>;

let credentialProvider: CredentialProvider | null = null;

/**
 * Initialize the AWS credential provider chain.
 * Called lazily on first Bedrock request.
 *
 * Resolution order follows the standard AWS SDK chain:
 *  1. Environment variables (fromEnv)
 *  2. ~/.aws/credentials with profile (fromIni)
 *  3. ECS task role (fromContainerMetadata)
 *  4. EC2 IMDS (fromInstanceMetadata)
 *
 * Each provider throws when credentials are unavailable; the chain tries
 * them in order until one succeeds.
 *
 * @param profile - Optional AWS profile name (from AWS_PROFILE or LORE_BEDROCK_PROFILE)
 */
async function getCredentialProvider(
  profile?: string,
): Promise<CredentialProvider> {
  if (credentialProvider) return credentialProvider;

  const profileName = profile ?? process.env.AWS_PROFILE;

  // Build a manual chain: try each provider in order until one succeeds.
  // Using @aws-sdk/credential-providers directly is simpler than the
  // @smithy/property-provider chain() combinator and avoids extra deps.
  const providers: CredentialProvider[] = [
    fromEnv(),
    fromIni({ profile: profileName }),
    fromContainerMetadata(),
    fromInstanceMetadata(),
  ];

  credentialProvider = async () => {
    let lastError: Error | null = null;
    for (const provider of providers) {
      try {
        return await provider();
      } catch (e) {
        lastError = e instanceof Error ? e : new Error(String(e));
      }
    }
    throw lastError ?? new Error("No AWS credentials available");
  };

  return credentialProvider;
}

// ---------------------------------------------------------------------------
// SigV4 signing
// ---------------------------------------------------------------------------

/**
 * Sign an HTTP request with AWS SigV4 for the Bedrock service.
 *
 * @param method    HTTP method (POST)
 * @param url       Full URL (https://bedrock-runtime.{region}.amazonaws.com/...)
 * @param headers   Request headers (will be mutated with Authorization, x-amz-*, etc.)
 * @param body      Request body (string)
 * @param region    AWS region (e.g. "us-east-1")
 * @param profile   Optional AWS profile name
 */
export async function signBedrockRequest(
  method: string,
  url: string,
  headers: Record<string, string>,
  body: string,
  region: string,
  profile?: string,
): Promise<void> {
  const provider = await getCredentialProvider(profile);
  const credentials = await provider();

  const signer = new SignatureV4({
    credentials,
    region,
    service: "bedrock",
    sha256: Sha256,
  });

  // Parse URL for signing
  const parsedUrl = new URL(url);
  const hostname = parsedUrl.hostname;
  const pathname = parsedUrl.pathname;
  const query: Record<string, string> = {};
  parsedUrl.searchParams.forEach((value, key) => {
    query[key] = value;
  });

  // Build the HttpRequest for Smithy signer
  const httpRequest = new HttpRequest({
    method,
    hostname,
    protocol: parsedUrl.protocol,
    path: pathname,
    query,
    headers,
    body,
  });

  const signed = await signer.sign(httpRequest);

  // Copy signed headers back (Authorization, x-amz-date, x-amz-content-sha256, etc.)
  for (const [key, value] of Object.entries(signed.headers)) {
    headers[key] = value as string;
  }
}

/**
 * Reset cached credential provider (for testing).
 */
export function _resetBedrockCredentials(): void {
  credentialProvider = null;
}
