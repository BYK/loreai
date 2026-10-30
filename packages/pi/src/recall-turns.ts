import type { RecallToolContext } from "@loreai/core";

type TurnGroup = {
  gateway: string;
  projectPath: string;
  sessionID: string;
  active: number;
  ambiguous: boolean;
  pending: Map<string, RecallToolContext>;
  origins: Map<string, RecallToolContext | null>;
  owners: Map<string, { active: number; pending: Set<string> }>;
  originOwners: Map<string, string>;
};
const groups = new Map<string, TurnGroup>();

type PiRequestMetadata = {
  projectPath: string;
  sessionID: string;
  gitRemote: string;
  sessionTitle: string;
};
type RequestOwners = {
  owners: Map<string, PiRequestMetadata>;
  overflow: number;
};
const requestOwners = new Map<string, RequestOwners>();

/** Keep live factory metadata separate from the bounded, evictable turn cache. */
export function trackPiRequestOwner(
  gateway: string,
  ownerID: string,
  metadata: PiRequestMetadata,
): { update: (next: PiRequestMetadata) => void; retire: () => void } {
  let registry = requestOwners.get(gateway);
  if (!registry) {
    registry = { owners: new Map(), overflow: 0 };
    requestOwners.set(gateway, registry);
  }
  const state = registry;
  const tracked = state.owners.size < 256;
  let retired = false;
  if (tracked) state.owners.set(ownerID, { ...metadata });
  else state.overflow++;
  return {
    update(next) {
      if (!retired && tracked) state.owners.set(ownerID, { ...next });
    },
    retire() {
      if (retired) return;
      retired = true;
      if (tracked) state.owners.delete(ownerID);
      else state.overflow--;
      if (state.owners.size === 0 && state.overflow === 0)
        requestOwners.delete(gateway);
    },
  };
}

/** Untagged auxiliary requests cannot borrow an active factory's turn. */
export function singlePiRequestOwner(
  gateway: string,
  headers?: Headers,
): { ownerID: string; metadata: PiRequestMetadata } | undefined {
  const registry = requestOwners.get(gateway);
  // Never silently evict a live owner and mistake another one for unique.
  if (!registry || registry.overflow > 0) return undefined;
  const project = headers?.get("x-lore-project");
  const session = headers?.get("x-lore-session-id");
  let candidate: { ownerID: string; metadata: PiRequestMetadata } | undefined;
  for (const [ownerID, metadata] of registry.owners) {
    if (
      (project && metadata.projectPath !== project) ||
      (session && metadata.sessionID !== session)
    )
      continue;
    if (candidate) return undefined;
    candidate = { ownerID, metadata };
  }
  return candidate;
}

/** Shared ownership survives extension reloads, while scopes remain distinct. */
export function piTurnGroup(
  gateway: string,
  projectPath: string,
  sessionID: string,
  create = false,
): TurnGroup | undefined {
  const key = JSON.stringify([gateway, projectPath, sessionID]);
  let group = groups.get(key);
  if (!group && create) {
    if (groups.size >= 256) {
      const idle = [...groups].find(
        ([, entry]) => entry.active === 0 && entry.pending.size === 0,
      );
      if (!idle) return undefined;
      groups.delete(idle[0]);
    }
    group = {
      gateway,
      projectPath,
      sessionID,
      active: 0,
      ambiguous: false,
      pending: new Map(),
      origins: new Map(),
      owners: new Map(),
      originOwners: new Map(),
    };
    groups.set(key, group);
  }
  return group;
}

function ownerFor(group: TurnGroup, ownerID: string) {
  let owner = group.owners.get(ownerID);
  if (!owner && group.owners.size < 256) {
    owner = { active: 0, pending: new Set<string>() };
    group.owners.set(ownerID, owner);
  }
  return owner;
}

export function startPiOwner(group: TurnGroup, ownerID: string): void {
  const owner = ownerFor(group, ownerID);
  if (!owner) return;
  owner.active++;
  group.active++;
}

export function startPiTurn(
  group: TurnGroup,
  ownerID: string,
  turn: RecallToolContext,
): boolean {
  const owner = ownerFor(group, ownerID);
  if (!owner || !turn.turnID || group.pending.size >= 256) return false;
  if (group.pending.size > 0) group.ambiguous = true;
  owner.pending.add(turn.turnID);
  group.pending.set(turn.turnID, turn);
  return true;
}

export function bindPiOrigin(
  group: TurnGroup,
  ownerID: string,
  key: string,
  turn: RecallToolContext,
): void {
  group.origins.set(key, turn);
  group.originOwners.set(key, ownerID);
  group.pending.delete(turn.turnID!);
  group.owners.get(ownerID)?.pending.delete(turn.turnID!);
  if (group.origins.size > 256) {
    const oldest = group.origins.keys().next().value;
    if (oldest !== undefined) {
      group.origins.delete(oldest);
      group.originOwners.delete(oldest);
    }
  }
}

function clearPending(group: TurnGroup, ownerID: string): void {
  const owner = group.owners.get(ownerID);
  if (!owner) return;
  for (const turnID of owner.pending) group.pending.delete(turnID);
  owner.pending.clear();
  if (group.active === 0 && group.pending.size === 0) group.ambiguous = false;
}

export function endPiOwner(group: TurnGroup, ownerID: string): void {
  const owner = group.owners.get(ownerID);
  if (!owner) return;
  if (owner.active > 0) {
    owner.active--;
    group.active--;
  }
  if (owner.active === 0) clearPending(group, ownerID);
}

/** Interrupted owners may never receive agent_end after Pi disconnects events. */
export function retirePiOwner(gateway: string, ownerID: string): void {
  for (const group of groups.values()) {
    if (group.gateway !== gateway) continue;
    const owner = group.owners.get(ownerID);
    if (!owner) continue;
    group.active -= owner.active;
    owner.active = 0;
    clearPending(group, ownerID);
    group.owners.delete(ownerID);
    for (const [key, originOwner] of group.originOwners) {
      if (originOwner === ownerID) {
        // Keep a bounded tombstone so a late old assistant cannot be rebound
        // to a newer owner's nonce after shutdown or compaction.
        group.origins.set(key, null);
        group.originOwners.delete(key);
      }
    }
  }
}

/** Unregistered providers get attribution only from one proven pending turn. */
export function singlePendingPiTurn(
  gateway: string,
  headers?: Headers,
  ownerID?: string,
): RecallToolContext | undefined {
  const project = headers?.get("x-lore-project");
  const session = headers?.get("x-lore-session-id");
  const candidates: RecallToolContext[] = [];
  for (const group of groups.values()) {
    if (
      group.gateway !== gateway ||
      (project && group.projectPath !== project) ||
      (session && group.sessionID !== session)
    )
      continue;
    if (group.ambiguous || group.pending.size > 1) return undefined;
    for (const turn of group.pending.values()) {
      if (ownerID && !group.owners.get(ownerID)?.pending.has(turn.turnID!))
        return undefined;
      candidates.push(turn);
    }
  }
  return candidates.length === 1 ? candidates[0] : undefined;
}
