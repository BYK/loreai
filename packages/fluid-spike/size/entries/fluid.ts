import {
  SchemaFactory,
  SharedTree,
  Tree,
  TreeViewConfiguration,
} from "fluid-framework";

const sf = new SchemaFactory("lore.spike");
class Reply extends sf.object("Reply", {
  author: sf.string,
  text: sf.string,
  at: sf.number,
}) {}
class Anchor extends sf.object("Anchor", {
  blockId: sf.string,
  start: sf.number,
  end: sf.number,
  quote: sf.string,
}) {}
class Discussion extends sf.object("Discussion", {
  anchor: Anchor,
  replies: sf.array(Reply),
}) {}
const config = new TreeViewConfiguration({ schema: Discussion });
Object.assign(globalThis, { spikeSize: { SharedTree, Tree, config } });
