/**
 * Must be evaluated before `arktype` itself: the UI ships under
 * `script-src 'self'` (no unsafe-eval), so ArkType's `new Function`
 * JIT is unavailable and every contract runs the jitless validators.
 */
import { configure } from "arktype/config";

configure({ jitless: true });
