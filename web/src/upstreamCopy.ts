import type { DraftKey } from "./types";

export function upstreamCredentialsText(baseUrl: string, keys: readonly DraftKey[]): string {
  return [`Base URL: ${baseUrl}`, ...keys.map((key) => `API Key: ${key.api_key}`)].join("\n");
}
