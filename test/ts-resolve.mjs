import { registerHooks } from "node:module";

/**
 * The app's own imports are extensionless — the bundler resolves them, node's
 * ESM resolver does not. This lets a test import a module out of `lib/`
 * directly (node strips the types itself), with no build step and no deps.
 */
registerHooks({
  resolve(spec, ctx, next) {
    if (spec.startsWith("@/")) {
      return next(new URL(`../${spec.slice(2)}.ts`, import.meta.url).href, ctx);
    }
    if (spec.startsWith(".") && !/\.[cm]?[jt]s$/.test(spec)) {
      try {
        return next(`${spec}.ts`, ctx);
      } catch {
        // not a .ts module: fall through to node's own resolution
      }
    }
    return next(spec, ctx);
  },
});
