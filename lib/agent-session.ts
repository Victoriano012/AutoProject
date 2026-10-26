import { providerForModel, type ModelChoice, type ModelProvider } from "./models";

const PREFIX = /^(claude|codex|gemini):(.*)$/;

/** Sessions created before provider support were all Claude sessions. */
export function sessionProvider(sessionId: string): ModelProvider {
  return (PREFIX.exec(sessionId)?.[1] as ModelProvider | undefined) ?? "claude";
}

/** Persist the provider with the otherwise opaque CLI session ID. */
export function tagSession(provider: ModelProvider, sessionId: string): string {
  return `${provider}:${sessionId}`;
}

/** Return the raw CLI session ID only when it belongs to the selected model's
 * provider. Switching providers therefore starts a clean conversation. */
export function resumableSession(
  sessionId: string | undefined,
  model: string,
  catalog?: readonly ModelChoice[],
): { stored: string; raw: string } | undefined {
  if (!sessionId || sessionProvider(sessionId) !== providerForModel(model, catalog)) return;
  const match = PREFIX.exec(sessionId);
  return { stored: sessionId, raw: match?.[2] ?? sessionId };
}
