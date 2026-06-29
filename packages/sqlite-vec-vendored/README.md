# @loreai/sqlite-vec-vendored

Vendored [`sqlite-vec`](https://github.com/asg017/sqlite-vec) `v0.1.10-alpha.4`
loadable extension, rebuilt from source with **DiskANN** and **rescore** enabled,
shipped as prebuilt binaries for `linux-x64`, `linux-arm64`, `darwin-arm64`, and
`windows-x64`.

It is a drop-in replacement for the `sqlite-vec` npm package's
`getLoadablePath()`. See [`SOURCE.md`](./SOURCE.md) for full provenance, the
exact upstream tag, the applied patches, and the per-platform build recipe.

```ts
import { getLoadablePath } from "@loreai/sqlite-vec-vendored";

const path = getLoadablePath(); // -> .../prebuilt/<target>/vec0.<ext> | undefined
if (path) db.loadExtension(path);
```

## Licensing

The wrapper code (`src/`) is licensed under `FSL-1.1-Apache-2.0` like the rest of
the Lore monorepo. The vendored `sqlite-vec` sources and the prebuilt binaries
derived from them are licensed by upstream under **Apache-2.0 OR MIT** — see
[`LICENSE-APACHE`](./LICENSE-APACHE) and [`LICENSE-MIT`](./LICENSE-MIT).
