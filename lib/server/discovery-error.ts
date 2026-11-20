/** A failure reason we wrote ourselves, and so may show to the person. A raw
 * error from a CLI or SDK can carry file paths, argv or credentials, so it is
 * never displayed — only reasons wrapped in this class survive to the UI.
 *
 * Lives apart from model-discovery so the catalog can recognise one without
 * statically importing the agent SDK. */
export class DiscoveryError extends Error {
  constructor(reason: string) { super(reason); }
}

/** Phrased to read after a provider name: "Codex timed out". */
export const discoveryReason = (error: unknown): string =>
  error instanceof DiscoveryError ? error.message : "could not be reached";
