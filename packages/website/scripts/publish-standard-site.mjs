#!/usr/bin/env node
/**
 * Publish the Lore blog's standard.site records (https://standard.site) to the
 * `@withlore.ai` Bluesky PDS over AT Protocol.
 *
 * Records are read from the build manifest (dist/standard-site.json), so build
 * the site first:
 *
 *   pnpm --filter @loreai/website build
 *   BSKY_APP_PASSWORD='xxxx-xxxx-xxxx-xxxx' pnpm --filter @loreai/website publish:standard-site
 *
 * Auth uses a Bluesky app password (create one at
 * https://bsky.app/settings/app-passwords). It is read from BSKY_APP_PASSWORD
 * and never logged. BSKY_HANDLE defaults to "withlore.ai".
 *
 * Idempotent: records use deterministic rkeys (publication "self", documents =
 * post slug) written with putRecord, so re-running updates them in place rather
 * than creating duplicates.
 */

import { readFile } from "node:fs/promises";

const HANDLE = process.env.BSKY_HANDLE ?? "withlore.ai";
const PASSWORD = process.env.BSKY_APP_PASSWORD;
const MANIFEST_URL = new URL("../dist/standard-site.json", import.meta.url);
const WELL_KNOWN_URL = new URL(
  "../public/.well-known/site.standard.publication",
  import.meta.url,
);

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

async function xrpcGet(baseUrl, nsid, query) {
  const url = new URL(`/xrpc/${nsid}`, baseUrl);
  for (const [key, value] of Object.entries(query ?? {})) {
    url.searchParams.set(key, value);
  }
  const res = await fetch(url);
  if (!res.ok) fail(`${nsid} -> ${res.status}: ${await res.text()}`);
  return res.json();
}

async function xrpcPost(baseUrl, nsid, body, token) {
  const res = await fetch(new URL(`/xrpc/${nsid}`, baseUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) fail(`${nsid} -> ${res.status}: ${await res.text()}`);
  return res.json();
}

async function resolvePds(did) {
  const res = await fetch(`https://plc.directory/${did}`);
  if (!res.ok) fail(`could not resolve DID document for ${did}: ${res.status}`);
  const doc = await res.json();
  const pds = (doc.service ?? []).find(
    (s) => s.type === "AtprotoPersonalDataServer",
  )?.serviceEndpoint;
  if (!pds) fail(`no PDS endpoint in DID document for ${did}`);
  return pds;
}

async function readManifest() {
  let raw;
  try {
    raw = await readFile(MANIFEST_URL, "utf8");
  } catch {
    fail(
      "dist/standard-site.json not found — run `pnpm --filter @loreai/website build` first",
    );
  }
  const manifest = JSON.parse(raw);

  // Guard against drift between the static verification file and the records.
  const wellKnown = (await readFile(WELL_KNOWN_URL, "utf8")).trim();
  if (wellKnown !== manifest.publication.uri) {
    fail(
      `.well-known/site.standard.publication (${wellKnown}) does not match the ` +
        `publication record AT-URI (${manifest.publication.uri})`,
    );
  }
  return manifest;
}

async function main() {
  if (!PASSWORD) {
    fail(
      "BSKY_APP_PASSWORD is required (create an app password at https://bsky.app/settings/app-passwords)",
    );
  }

  const manifest = await readManifest();

  // Resolve identity -> PDS, then open an app-password session.
  const { did } = await xrpcGet(
    "https://public.api.bsky.app",
    "com.atproto.identity.resolveHandle",
    { handle: HANDLE },
  );
  const pds = await resolvePds(did);
  const session = await xrpcPost(pds, "com.atproto.server.createSession", {
    identifier: HANDLE,
    password: PASSWORD,
  });
  console.log(`✓ authenticated as ${HANDLE} (${session.did}) on ${pds}`);

  // The records embed a hardcoded DID (their AT-URIs). If BSKY_HANDLE was
  // overridden to a different account, we would otherwise write the blog's
  // records into the wrong repo. Refuse unless the authenticated identity owns
  // the DID the records are addressed to.
  const recordDid = manifest.publication.uri.split("/")[2];
  if (session.did !== recordDid) {
    fail(
      `authenticated DID (${session.did}) does not match the DID in the ` +
        `records (${recordDid}); refusing to publish to the wrong repo`,
    );
  }

  const records = [
    {
      collection: manifest.publication.record.$type,
      rkey: manifest.publication.rkey,
      record: manifest.publication.record,
      uri: manifest.publication.uri,
    },
    ...manifest.documents.map((doc) => ({
      collection: doc.record.$type,
      rkey: doc.rkey,
      record: doc.record,
      uri: doc.uri,
    })),
  ];

  for (const { collection, rkey, record, uri } of records) {
    // validate:false — the PDS does not host the site.standard.* lexicons, so
    // schema validation would reject otherwise-valid records.
    await xrpcPost(
      pds,
      "com.atproto.repo.putRecord",
      { repo: session.did, collection, rkey, record, validate: false },
      session.accessJwt,
    );
    console.log(`✓ put ${uri}`);
  }

  console.log(
    `\nDone — published 1 publication + ${manifest.documents.length} document(s).`,
  );
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
