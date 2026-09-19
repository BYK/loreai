// Must be evaluated before `arktype` itself (imported first by arktype.mjs).
import { configure } from "arktype/config";

configure({ jitless: process.env.BENCH_ARKTYPE_JIT !== "1" });
