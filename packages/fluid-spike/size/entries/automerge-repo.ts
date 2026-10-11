import * as Automerge from "@automerge/automerge/slim";
import wasmUrl from "@automerge/automerge/automerge.wasm?url";
import { Repo } from "@automerge/automerge-repo/slim";
import { BrowserWebSocketClientAdapter } from "@automerge/automerge-repo-network-websocket";

Object.assign(globalThis, {
  spikeSize: async (url: string) => {
    await Automerge.initializeWasm(wasmUrl);
    const repo = new Repo({
      network: [new BrowserWebSocketClientAdapter(url)],
    });
    return repo.create<{ replies: unknown[] }>({ replies: [] });
  },
});
