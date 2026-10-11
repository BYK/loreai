# Fluid collaboration spike

Run commands from the repository root after `pnpm install`:

```sh
pnpm --filter @loreai/gateway run bundle
pnpm --filter @loreai/fluid-spike bench:cjs
pnpm --filter @loreai/fluid-spike bench
```

The benchmark commands write JSON and logs to `~/work/spike-results` by default.
Set `SPIKE_RESULTS_DIR` to use another persistent output directory. `bench`
runs the browser variant five times at 5 ms intervals and five burst runs;
`SPIKE_RUNS` can override the run count for a smoke test.

The CommonJS compatibility run uses the built gateway bundle and the bundled
Node participant:

```sh
pnpm --filter @loreai/fluid-spike bench:cjs:smoke
```

It performs one normal and one burst Node-only convergence run. Registry tag
evidence for Automerge Repo can be captured with
`pnpm --filter @loreai/fluid-spike report:automerge`.
