import { Tree, TreeViewConfiguration, type TreeView } from "fluid-framework";
import { TinyliciousClient } from "@fluidframework/tinylicious-client";
import type { TinyliciousContainerServices } from "@fluidframework/tinylicious-client";
import { identityTokenProvider } from "./identity";
import {
  Discussion,
  discussionContainerSchema,
  initialDiscussion,
} from "./schema";

export type ReplyValue = { author: string; text: string; at: number };
type FluidContainer = Awaited<
  ReturnType<TinyliciousClient["createContainer"]>
>["container"];

function createClient(author: string): TinyliciousClient {
  const domain = process.env.LORE_FLUID_DOMAIN ?? "http://127.0.0.1";
  const port = Number(process.env.LORE_FLUID_PORT ?? 7070);
  return new TinyliciousClient({
    connection: {
      domain,
      port,
      tokenProvider: identityTokenProvider(author, author, `${domain}:${port}`),
    },
  });
}

async function waitForConnection(container: FluidContainer) {
  const deadline = Date.now() + 20_000;
  while (
    !["2", "connected"].includes(
      String(container.connectionState).toLowerCase(),
    )
  ) {
    if (Date.now() >= deadline) throw new Error("Fluid client did not connect");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function makeParticipant(
  container: FluidContainer,
  services: TinyliciousContainerServices,
  view: TreeView<typeof Discussion>,
  author: string,
) {
  const observations = new Map<string, { text: string; seen: number }>();
  const collect = () => {
    for (const reply of view.root.replies) {
      if (reply.author !== author && !observations.has(reply.text)) {
        observations.set(reply.text, {
          text: reply.text,
          seen: performance.timeOrigin + performance.now(),
        });
      }
    }
  };
  Tree.on(view.root.replies, "nodeChanged", collect);
  collect();
  const appendAs = (text: string, replyAuthor: string): ReplyValue => {
    const reply = {
      author: replyAuthor,
      text,
      at: performance.timeOrigin + performance.now(),
    };
    view.root.replies.insertAtEnd(reply);
    return reply;
  };
  return {
    append: (text: string): ReplyValue => {
      return appendAs(text, author);
    },
    appendAs,
    state: (): ReplyValue[] =>
      Array.from(view.root.replies, ({ author: replyAuthor, text, at }) => ({
        author: replyAuthor,
        text,
        at,
      })),
    observations: () => [...observations.values()],
    audience: () =>
      [...services.audience.getMembers()].map(([clientId, member]) => ({
        clientId,
        user: { id: member.id, name: member.name },
        identityClientAsserted: false,
      })),
    connected: () => String(container.connectionState),
    close: () => container.dispose(),
  };
}

export async function createDiscussion(author = "alice") {
  const client = createClient(author);
  const { container, services } = await client.createContainer(
    discussionContainerSchema,
    "2.0.0",
  );
  const view = container.initialObjects.discussion.viewWith(
    new TreeViewConfiguration({ schema: Discussion }),
  );
  view.initialize(initialDiscussion);
  const id = await container.attach();
  await waitForConnection(container);
  return {
    id,
    participant: makeParticipant(container, services, view, author),
  };
}

export async function joinDiscussion(id: string, author: string) {
  const client = createClient(author);
  const { container, services } = await client.getContainer(
    id,
    discussionContainerSchema,
    "2.0.0",
  );
  const view = container.initialObjects.discussion.viewWith(
    new TreeViewConfiguration({ schema: Discussion }),
  );
  await waitForConnection(container);
  return makeParticipant(container, services, view, author);
}

export async function shareDiscussion(
  id: string,
  owner: string,
  participant: string,
): Promise<void> {
  await updateShare(id, owner, participant, "POST");
}

export async function unshareDiscussion(
  id: string,
  owner: string,
  participant: string,
): Promise<void> {
  await updateShare(id, owner, participant, "DELETE");
}

async function updateShare(
  id: string,
  owner: string,
  participant: string,
  method: "POST" | "DELETE",
): Promise<void> {
  const domain = process.env.LORE_FLUID_DOMAIN ?? "http://127.0.0.1";
  const port = Number(process.env.LORE_FLUID_PORT ?? 7070);
  const tokenProvider = identityTokenProvider(
    owner,
    owner,
    `${domain}:${port}`,
  );
  const token = await tokenProvider.fetchOrdererToken("fluid", id);
  const response = await fetch(`${domain}:${port}/fluid-spike/share`, {
    method,
    headers: {
      Authorization: `Bearer ${token.jwt}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ documentId: id, participant }),
  });
  if (!response.ok) throw new Error(`Fluid share denied (${response.status})`);
}

export async function getFluidAttribution(
  id: string,
  participant: string,
): Promise<
  Array<{
    sequenceNumber: number;
    clientId: string;
    participant: string | null;
    operation: string;
  }>
> {
  const domain = process.env.LORE_FLUID_DOMAIN ?? "http://127.0.0.1";
  const port = Number(process.env.LORE_FLUID_PORT ?? 7070);
  const tokenProvider = identityTokenProvider(
    participant,
    participant,
    `${domain}:${port}`,
  );
  const token = await tokenProvider.fetchOrdererToken("fluid", id);
  const response = await fetch(
    `${domain}:${port}/fluid-spike/attribution/${encodeURIComponent(id)}`,
    { headers: { Authorization: `Bearer ${token.jwt}` } },
  );
  if (!response.ok) {
    throw new Error(`Fluid attribution query failed (${response.status})`);
  }
  const result = (await response.json()) as {
    entries: Array<{
      sequenceNumber: number;
      clientId: string;
      participant: string | null;
      operation: string;
    }>;
  };
  return result.entries;
}
export { identityTokenProvider } from "./identity";
