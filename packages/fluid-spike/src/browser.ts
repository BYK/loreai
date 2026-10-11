import {
  Tree,
  TreeViewConfiguration,
  type IFluidContainer,
  type TreeView,
} from "fluid-framework";
import {
  TinyliciousClient,
  type TinyliciousContainerServices,
} from "@fluidframework/tinylicious-client";
import type { OldestSupportedClientVersion } from "@fluidframework/tinylicious-client";
import { identityTokenProvider } from "./identity";
import {
  Discussion,
  discussionContainerSchema,
  initialDiscussion,
} from "./schema";

type ReplyValue = { author: string; text: string; at: number };
type Observation = { reply: ReplyValue; seenAt: number };

declare global {
  interface Window {
    fluidSpike: {
      create: () => Promise<string>;
      load: (id: string) => Promise<void>;
      append: (author: string, text: string) => ReplyValue;
      observations: () => Observation[];
      finalState: () => ReplyValue[];
      connectionState: () => string;
      dispose: () => Promise<void>;
      share: (id: string, participant: string) => Promise<void>;
      unshare: (id: string, participant: string) => Promise<void>;
      audience: () => Array<{
        clientId: string;
        user: { id: string; name: string };
        identityClientAsserted: boolean;
      }>;
    };
  }
}

const query = new URLSearchParams(location.search);
const port = Number(query.get("port") ?? 7070);
const configuration = new TreeViewConfiguration({ schema: Discussion });
type FluidContainer = IFluidContainer<typeof discussionContainerSchema>;
let view: TreeView<typeof Discussion> | undefined;
let container: FluidContainer | undefined;
let services: TinyliciousContainerServices | undefined;
let activeDocumentId: string | undefined;
let activeTokenProvider: ReturnType<typeof identityTokenProvider> | undefined;
const observed = new Map<string, Observation>();

function now(): number {
  return performance.timeOrigin + performance.now();
}

function snapshot(): ReplyValue[] {
  if (!view) return [];
  return Array.from(view.root.replies, (reply: ReplyValue) => ({
    author: reply.author,
    text: reply.text,
    at: reply.at,
  }));
}

function collect(): void {
  if (!view) return;
  for (const reply of snapshot()) {
    const key = `${reply.author}:${reply.text}`;
    if (!observed.has(key)) observed.set(key, { reply, seenAt: now() });
  }
}

async function install(id: string | undefined): Promise<string> {
  const author = query.get("author") ?? "browser";
  const tokenProvider = identityTokenProvider(
    author,
    author,
    `http://127.0.0.1:${port}`,
  );
  const client = new TinyliciousClient({
    connection: {
      domain: "http://127.0.0.1",
      port,
      tokenProvider,
    },
  });
  const oldestSupportedClient: OldestSupportedClientVersion = "2.0.0";
  let result: {
    container: FluidContainer;
    services: TinyliciousContainerServices;
  };
  if (id) {
    result = await client.getContainer<typeof discussionContainerSchema>(
      id,
      discussionContainerSchema,
      oldestSupportedClient,
    );
  } else {
    result = await client.createContainer<typeof discussionContainerSchema>(
      discussionContainerSchema,
      oldestSupportedClient,
    );
  }
  const currentContainer = result.container;
  container = currentContainer;
  services = result.services;
  const currentView =
    currentContainer.initialObjects.discussion.viewWith(configuration);
  view = currentView;
  observed.clear();
  if (!id) currentView.initialize(initialDiscussion);
  Tree.on(currentView.root.replies, "nodeChanged", collect);
  collect();
  if (!id) id = await currentContainer.attach();
  activeDocumentId = id;
  activeTokenProvider = tokenProvider;
  return id;
}

window.fluidSpike = {
  create: () => install(undefined),
  load: async (id) => {
    await install(id);
  },
  append: (author, text) => {
    if (!view) throw new Error("No discussion is loaded");
    const reply = { author, text, at: now() };
    view.root.replies.insertAtEnd(reply);
    collect();
    return reply;
  },
  observations: () => [...observed.values()],
  finalState: snapshot,
  connectionState: () => String(container?.connectionState ?? "disconnected"),
  dispose: async () => {
    container?.dispose();
    container = undefined;
    view = undefined;
    services = undefined;
    activeDocumentId = undefined;
    activeTokenProvider = undefined;
  },
  share: async (id, participant) => {
    if (id !== activeDocumentId || !activeTokenProvider) {
      throw new Error("Discussion is not loaded");
    }
    const token = await activeTokenProvider.fetchOrdererToken("fluid", id);
    const response = await fetch(`http://127.0.0.1:${port}/fluid-spike/share`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token.jwt}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ documentId: id, participant }),
    });
    if (!response.ok)
      throw new Error(`Fluid share denied (${response.status})`);
  },
  unshare: async (id, participant) => {
    if (id !== activeDocumentId || !activeTokenProvider) {
      throw new Error("Discussion is not loaded");
    }
    const token = await activeTokenProvider.fetchOrdererToken("fluid", id);
    const response = await fetch(`http://127.0.0.1:${port}/fluid-spike/share`, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${token.jwt}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ documentId: id, participant }),
    });
    if (!response.ok)
      throw new Error(`Fluid unshare denied (${response.status})`);
  },
  audience: () =>
    [...(services?.audience.getMembers() ?? [])].map(([clientId, member]) => ({
      clientId,
      user: { id: member.id, name: member.name },
      identityClientAsserted: false,
    })),
};
