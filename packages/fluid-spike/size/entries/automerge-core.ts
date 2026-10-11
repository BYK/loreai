import * as Automerge from "@automerge/automerge/slim";
import wasmUrl from "@automerge/automerge/automerge.wasm?url";

Object.assign(globalThis, {
  spikeSize: async () => {
    await Automerge.initializeWasm(wasmUrl);
    return Automerge.change(Automerge.init<{ replies: unknown[] }>(), (d) => {
      d.replies = [];
    });
  },
});
