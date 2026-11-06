import { loadConfig } from "./config.js";

// Minimal structural types for the real host fields used here; not a replacement SDK.
interface AuthorizeContext {
  redirectUri: string;
  state: string;
  codeChallenge: string;
}
interface FetchContext {
  fetch(input: string, init?: RequestInit): Promise<Response>;
}
interface ExchangeContext extends FetchContext {
  redirectUri: string;
  code: string;
  codeVerifier: string;
}
interface RefreshContext extends FetchContext {
  account: { refreshToken: string };
}
interface Tokens {
  accessToken: string;
  expiresIn: number;
  refreshToken?: string;
}

const config = await loadConfig();

async function requestTokens(
  ctx: FetchContext,
  body: URLSearchParams,
  operation: string,
): Promise<Tokens> {
  const response = await ctx.fetch(config.tokenUrl, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body,
    // Never forward an authorization code or refresh token through a redirect.
    redirect: "error",
  });
  if (!response.ok) {
    throw new Error(`${operation} failed: HTTP ${response.status}`);
  }
  // SyntaxError messages may include response fragments. Do not expose a token body
  // in the login dialog or logs; retain the operation and HTTP status instead.
  const value: unknown = await response.json().catch((error: unknown) => {
    if (!(error instanceof SyntaxError)) throw error;
    throw new Error(
      `${operation}: invalid token JSON (HTTP ${response.status})`,
    );
  });
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !("access_token" in value) ||
    typeof value.access_token !== "string" ||
    !value.access_token.trim() ||
    !("token_type" in value) ||
    typeof value.token_type !== "string" ||
    value.token_type.toLowerCase() !== "bearer" ||
    !("expires_in" in value) ||
    typeof value.expires_in !== "number" ||
    !Number.isSafeInteger(value.expires_in) ||
    value.expires_in <= 0
  ) {
    throw new Error(
      `${operation}: expected a Bearer access_token and positive integer expires_in (HTTP ${response.status})`,
    );
  }
  const tokens: Tokens = {
    accessToken: value.access_token,
    expiresIn: value.expires_in,
  };
  if ("refresh_token" in value) {
    if (
      typeof value.refresh_token !== "string" ||
      !value.refresh_token.trim()
    ) {
      throw new Error(
        `${operation}: invalid refresh_token (HTTP ${response.status})`,
      );
    }
    tokens.refreshToken = value.refresh_token;
  }
  return tokens;
}

export default {
  providers: [
    {
      id: config.providerId,
      name: config.providerName,
      flow: "redirect",
      callback: {
        ports: [config.callbackPort],
        path: config.callbackPath,
        host: "127.0.0.1",
      },
      api: {
        baseUrl: config.apiBaseUrl,
        requestMethod: config.requestMethod,
        defaultModel: config.defaultModel,
        maxContextTokens: config.maxContextTokens,
        supportsVision: config.supportsVision,
      },
      authorize(ctx: AuthorizeContext) {
        const url = new URL(config.authorizationUrl);
        url.searchParams.set("response_type", "code");
        url.searchParams.set("client_id", config.clientId);
        url.searchParams.set("redirect_uri", ctx.redirectUri);
        url.searchParams.set("state", ctx.state);
        url.searchParams.set("code_challenge", ctx.codeChallenge);
        url.searchParams.set("code_challenge_method", "S256");
        if (config.scope) url.searchParams.set("scope", config.scope);
        return { url: url.href };
      },
      exchange(ctx: ExchangeContext) {
        return requestTokens(
          ctx,
          new URLSearchParams({
            grant_type: "authorization_code",
            client_id: config.clientId,
            code: ctx.code,
            redirect_uri: ctx.redirectUri,
            code_verifier: ctx.codeVerifier,
          }),
          "OAuth code exchange",
        );
      },
      refresh(ctx: RefreshContext) {
        if (!ctx.account.refreshToken)
          throw new Error(
            "OAuth refresh requires a refresh token issued by the provider",
          );
        return requestTokens(
          ctx,
          new URLSearchParams({
            grant_type: "refresh_token",
            client_id: config.clientId,
            refresh_token: ctx.account.refreshToken,
          }),
          "OAuth token refresh",
        );
      },
    },
  ],
};
