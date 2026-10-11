import * as Automerge from "@automerge/automerge/slim";
import { automergeWasmBase64 } from "@automerge/automerge/automerge.wasm.base64";

Object.assign(globalThis, {
  spikeSize: async () => {
    await Automerge.initializeBase64Wasm(automergeWasmBase64);
    return Automerge.change(Automerge.init<{ replies: unknown[] }>(), (d) => {
      d.replies = [];
    });
  },
});
