<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Putting a change live

AutoProject is served from this checkout on 127.0.0.1:4123. After committing a change that should go live, run `bin/autoproject --restart`: it builds beside the running app, then swaps servers at once. Agents at work, you included, are cut short and carry on in the same conversation on the new server, told the update is live; do not run it again then. A failed build leaves the old server running and the command says so.

Never stop or restart the server on 4123 directly. A plain `npm run build` writes `.next`, not the live build, so it is always safe.
