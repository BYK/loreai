// No-CRDT client: POST replies, receive server-ordered replies over SSE.
type Reply = { seq: number; author: string; text: string; at: number };

export function connect(
  base: string,
  discussionId: string,
  onReply: (r: Reply) => void,
) {
  const replies: Reply[] = [];
  const events = new EventSource(
    `${base}/api/v1/spike/discussions/${discussionId}/events`,
  );
  events.addEventListener("reply", (event) => {
    const reply = JSON.parse((event as MessageEvent<string>).data) as Reply;
    const last = replies.at(-1);
    if (last === undefined || reply.seq > last.seq) {
      replies.push(reply);
      onReply(reply);
    }
  });
  return {
    replies,
    append: (text: string) =>
      fetch(`${base}/api/v1/spike/discussions/${discussionId}/replies`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
      }),
    close: () => events.close(),
  };
}

Object.assign(globalThis, { spikeSize: { connect } });
