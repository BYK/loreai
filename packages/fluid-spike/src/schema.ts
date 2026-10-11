import { SchemaFactory, SharedTree } from "fluid-framework";

const schema = new SchemaFactory("lore.spike");

export class Reply extends schema.object("Reply", {
  author: schema.string,
  text: schema.string,
  at: schema.number,
}) {}

export class Anchor extends schema.object("Anchor", {
  blockId: schema.string,
  start: schema.number,
  end: schema.number,
  quote: schema.string,
}) {}

export class Discussion extends schema.object("Discussion", {
  anchor: Anchor,
  replies: schema.array(Reply),
}) {}

export const discussionContainerSchema = {
  initialObjects: { discussion: SharedTree },
};

export const initialDiscussion = {
  anchor: { blockId: "", start: 0, end: 0, quote: "" },
  replies: [],
};
