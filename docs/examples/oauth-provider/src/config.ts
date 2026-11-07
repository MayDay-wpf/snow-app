import { readFile } from "node:fs/promises";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`config.json: ${field} must be a non-empty string`);
  }
  return value.trim();
}

function httpsUrl(value: unknown, field: string): string {
  const input = text(value, field);
  if (!URL.canParse(input)) {
    throw new Error(`config.json: ${field} must be an absolute HTTPS URL`);
  }
  const url = new URL(input);
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new Error(
      `config.json: ${field} requires HTTPS without credentials or a fragment`,
    );
  }
  return url.href;
}

function positiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`config.json: ${field} must be a positive integer`);
  }
  return value;
}

// This file contains author configuration, never client secrets or account tokens.
// Read relative to oauth.mjs so the built plugin is independent of the working directory.
export async function loadConfig() {
  const value: unknown = JSON.parse(
    await readFile(new URL("./config.json", import.meta.url), "utf8"),
  );
  if (!record(value)) throw new Error("config.json must contain an object");
  const providerId = text(value.providerId, "providerId");
  if (
    !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(providerId) ||
    ["codex", "chatgpt", "anthropic", "antigravity", "xai"].includes(providerId)
  ) {
    throw new Error("config.json: providerId is invalid or reserved by Snow");
  }
  const callbackPort = positiveInteger(value.callbackPort, "callbackPort");
  if (callbackPort > 65535)
    throw new Error("config.json: callbackPort must be at most 65535");
  const callbackPath = text(value.callbackPath, "callbackPath");
  if (!/^\/(?!\/)[A-Za-z0-9/_-]*$/.test(callbackPath)) {
    throw new Error(
      "config.json: callbackPath must be an absolute path using letters, digits, /, _ or -",
    );
  }
  const requestMethod = value.requestMethod;
  if (
    requestMethod !== "chat" &&
    requestMethod !== "responses" &&
    requestMethod !== "anthropic" &&
    requestMethod !== "gemini"
  ) {
    throw new Error(
      "config.json: requestMethod must be chat, responses, anthropic or gemini",
    );
  }
  // An empty scope is valid for providers that do not require an explicit scope.
  if (
    typeof value.scope !== "string" ||
    (value.scope !== "" &&
      !/^[\x21\x23-\x5B\x5D-\x7E]+(?: [\x21\x23-\x5B\x5D-\x7E]+)*$/.test(
        value.scope,
      ))
  ) {
    throw new Error(
      "config.json: scope must contain space-separated OAuth scope tokens, or be empty",
    );
  }
  if (typeof value.supportsVision !== "boolean") {
    throw new Error("config.json: supportsVision must be a boolean");
  }
  return {
    providerId,
    providerName: text(value.providerName, "providerName"),
    clientId: text(value.clientId, "clientId"),
    authorizationUrl: httpsUrl(value.authorizationUrl, "authorizationUrl"),
    tokenUrl: httpsUrl(value.tokenUrl, "tokenUrl"),
    scope: value.scope,
    callbackPort,
    callbackPath,
    apiBaseUrl: httpsUrl(value.apiBaseUrl, "apiBaseUrl"),
    requestMethod,
    defaultModel: text(value.defaultModel, "defaultModel"),
    maxContextTokens: positiveInteger(
      value.maxContextTokens,
      "maxContextTokens",
    ),
    supportsVision: value.supportsVision,
  };
}
