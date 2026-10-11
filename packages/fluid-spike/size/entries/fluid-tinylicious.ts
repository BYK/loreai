import {
  SchemaFactory,
  SharedTree,
  Tree,
  TreeViewConfiguration,
} from "fluid-framework";
import { TinyliciousClient } from "@fluidframework/tinylicious-client";

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
const client = new TinyliciousClient({
  connection: { domain: "http://127.0.0.1", port: 7070 },
});
Object.assign(globalThis, {
  spikeSize: {
    config,
    Tree,
    create: () =>
      client.createContainer(
        { initialObjects: { discussion: SharedTree } },
        "2",
      ),
  },
});
