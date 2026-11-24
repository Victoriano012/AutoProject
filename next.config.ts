import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The launcher builds and serves the live app from `.next-live/a` or `/b`,
  // so a plain `npm run build` (an agent checking its work) never touches it.
  // tsconfig.json lists their type folders, so a build never rewrites it, and
  // excludes them, so the served build's stale route types never fail a check.
  distDir: process.env.AUTOPROJECT_DIST_DIR || ".next",
  // The Agent SDK spawns a bundled CLI subprocess; keep it unbundled so its
  // runtime files are traced into the serverless function as-is.
  serverExternalPackages: ["@anthropic-ai/claude-agent-sdk"],
};

export default nextConfig;
