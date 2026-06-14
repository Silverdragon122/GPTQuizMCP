import { afterEach, describe, expect, it, vi } from "vitest";
import { handleRequest } from "../src";

describe("mcp auth security", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("keeps explicit no-auth quiz calls public", async () => {
    const env = { AUTH_MODE: "none", WIDGET_DOMAIN: "https://quiz.example.com" };
    const listResponse = await mcp({ jsonrpc: "2.0", id: "list", method: "tools/list" }, env);
    const listBody = await listResponse.json() as any;

    expect(listBody.result.tools[0].securitySchemes).toEqual([{ type: "noauth" }]);
    expect(listBody.result.tools[0]._meta["openai/outputTemplate"]).toBe("ui://widget/inline-quiz-v10.html");

    const callResponse = await mcp({
      jsonrpc: "2.0",
      id: "call",
      method: "tools/call",
      params: { name: "render_inline_quiz", arguments: quizArgs("No auth quiz") }
    }, env);
    const callBody = await callResponse.json() as any;

    expect(callBody.result.structuredContent.title).toBe("No auth quiz");
    expect(callBody.result._meta["mcp/www_authenticate"]).toBeUndefined();
  });

  it("fails closed when AUTH_MODE is invalid", async () => {
    const response = await mcp({
      jsonrpc: "2.0",
      id: "call",
      method: "tools/call",
      params: { name: "render_inline_quiz", arguments: quizArgs("Should not render") }
    }, { AUTH_MODE: "oauth_typo", WIDGET_DOMAIN: "https://quiz.example.com" });
    const body = await response.json() as any;

    expect(response.status).toBe(404);
    expect(body.error).toBe("Not found");
    expect(body.result).toBeUndefined();
  });

  it("does not authenticate or answer JSON-RPC notifications", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await mcp({
      jsonrpc: "2.0",
      method: "tools/call",
      params: { name: "render_inline_quiz", arguments: quizArgs("Notification quiz") }
    }, oauthEnv(), { Authorization: `Bearer ${fakeJwt()}` });

    expect(response.status).toBe(202);
    expect(await response.text()).toBe("");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("filters notifications out of batches and rejects empty batches", async () => {
    const batchResponse = await mcp([
      {
        jsonrpc: "2.0",
        method: "tools/call",
        params: { name: "render_inline_quiz", arguments: quizArgs("Notification quiz") }
      },
      { jsonrpc: "2.0", id: "pong", method: "ping" }
    ], oauthEnv());
    const batchBody = await batchResponse.json() as any;

    expect(batchBody).toHaveLength(1);
    expect(batchBody[0].id).toBe("pong");
    expect(batchBody[0].result).toEqual({});

    const emptyResponse = await mcp([], { WIDGET_DOMAIN: "https://quiz.example.com" });
    const emptyBody = await emptyResponse.json() as any;
    expect(emptyResponse.status).toBe(400);
    expect(emptyBody.error.message).toContain("at least one");
  });

  it("returns unknown-method errors in OAuth mode without fetching JWKS", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await mcp({
      jsonrpc: "2.0",
      id: "unknown",
      method: "unknown/protected",
      params: {}
    }, oauthEnv(), { Authorization: `Bearer ${fakeJwt()}` });
    const body = await response.json() as any;

    expect(response.status).toBe(200);
    expect(body.error.code).toBe(-32601);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("restricts CORS preflights to trusted origins", async () => {
    const allowed = await handleRequest(
      new Request("https://quiz.example.com/mcp", {
        method: "OPTIONS",
        headers: {
          Origin: "https://chatgpt.com",
          "Access-Control-Request-Method": "POST"
        }
      }),
      { WIDGET_DOMAIN: "https://quiz.example.com" }
    );
    expect(allowed.status).toBe(204);
    expect(allowed.headers.get("access-control-allow-origin")).toBe("https://chatgpt.com");
    expect(allowed.headers.get("vary")).toBe("Origin");

    const denied = await handleRequest(
      new Request("https://quiz.example.com/mcp", {
        method: "OPTIONS",
        headers: {
          Origin: "https://evil.example",
          "Access-Control-Request-Method": "POST"
        }
      }),
      { WIDGET_DOMAIN: "https://quiz.example.com" }
    );
    expect(denied.status).toBe(403);
    expect(denied.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("filters OAuth metadata and sanitizes challenge scope values", async () => {
    const env = {
      ...oauthEnv(),
      OAUTH_AUTHORIZATION_SERVERS:
        "https://auth.example.com http://insecure.example https://user:pass@auth.example.com https://tenant.example.com/oauth",
      OAUTH_RESOURCE_DOCUMENTATION: "javascript:alert(1)",
      OAUTH_SCOPES: "quiz:render\"\r\nbad"
    };

    const metadataResponse = await handleRequest(
      new Request("https://quiz.example.com/.well-known/oauth-protected-resource"),
      env
    );
    const metadata = await metadataResponse.json() as any;

    expect(metadata.authorization_servers).toEqual([
      "https://auth.example.com",
      "https://tenant.example.com/oauth"
    ]);
    expect(metadata.resource_documentation).toBeUndefined();
    expect(metadata.scopes_supported).toEqual(["quiz:render"]);

    const callResponse = await mcp({
      jsonrpc: "2.0",
      id: "call",
      method: "tools/call",
      params: { name: "render_inline_quiz", arguments: quizArgs("Protected quiz") }
    }, env);
    const callBody = await callResponse.json() as any;
    const challenge = callBody.result._meta["mcp/www_authenticate"][0] as string;

    expect(challenge).toContain('scope="quiz:render"');
    expect(challenge).not.toContain("\r");
    expect(challenge).not.toContain("\n");
    expect(challenge).not.toContain("bad");
  });

  it("rejects unsafe JWKS URLs and non-JSON JWKS responses", async () => {
    const unsafeFetchMock = vi.fn();
    vi.stubGlobal("fetch", unsafeFetchMock);

    const unsafeResponse = await mcp({
      jsonrpc: "2.0",
      id: "call",
      method: "tools/call",
      params: { name: "render_inline_quiz", arguments: quizArgs("Protected quiz") }
    }, {
      ...oauthEnv(),
      OAUTH_JWKS_URL: "http://auth.example.com/.well-known/jwks.json"
    }, { Authorization: `Bearer ${fakeJwt()}` });
    const unsafeBody = await unsafeResponse.json() as any;

    expect(unsafeBody.result.isError).toBe(true);
    expect(unsafeFetchMock).not.toHaveBeenCalled();

    const nonJsonFetchMock = vi.fn(async () => new Response("{\"keys\":[]}", {
      headers: { "Content-Type": "text/plain" }
    }));
    vi.stubGlobal("fetch", nonJsonFetchMock);

    const nonJsonResponse = await mcp({
      jsonrpc: "2.0",
      id: "call",
      method: "tools/call",
      params: { name: "render_inline_quiz", arguments: quizArgs("Protected quiz") }
    }, oauthEnv(), { Authorization: `Bearer ${fakeJwt()}` });
    const nonJsonBody = await nonJsonResponse.json() as any;

    expect(nonJsonBody.result.isError).toBe(true);
    expect(nonJsonFetchMock).toHaveBeenCalledTimes(1);
  });

  it("derives the OAuth audience from the request origin when configured as auto", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      keys: [{ kty: "RSA", kid: "key-1", alg: "RS256", use: "sig", n: "AQAB", e: "AQAB" }]
    }), {
      headers: { "Content-Type": "application/json" }
    }));
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(crypto.subtle, "importKey").mockResolvedValue({} as CryptoKey);
    vi.spyOn(crypto.subtle, "verify").mockResolvedValue(true);

    const response = await mcp({
      jsonrpc: "2.0",
      id: "call",
      method: "tools/call",
      params: { name: "render_inline_quiz", arguments: quizArgs("Auto audience quiz") }
    }, {
      ...oauthEnv(),
      OAUTH_AUDIENCE: "auto",
      OAUTH_RESOURCE: undefined,
      PUBLIC_BASE_URL: "",
      WIDGET_DOMAIN: ""
    }, { Authorization: `Bearer ${fakeJwt()}` });
    const body = await response.json() as any;

    expect(body.result.structuredContent.title).toBe("Auto audience quiz");
    expect(body.result.isError).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith("https://auth.example.com/.well-known/jwks.json", expect.any(Object));
  });
});

async function mcp(payload: unknown, env: Record<string, string | undefined>, headers: Record<string, string> = {}) {
  return handleRequest(
    new Request("https://quiz.example.com/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...headers
      },
      body: JSON.stringify(payload)
    }),
    env
  );
}

function oauthEnv() {
  return {
    AUTH_MODE: "oauth",
    OAUTH_AUDIENCE: "https://quiz.example.com",
    OAUTH_AUTHORIZATION_SERVERS: "https://auth.example.com",
    OAUTH_ISSUER: "https://auth.example.com",
    OAUTH_JWKS_URL: "https://auth.example.com/.well-known/jwks.json",
    OAUTH_RESOURCE: "https://quiz.example.com",
    OAUTH_SCOPES: "quiz:render",
    PUBLIC_BASE_URL: "https://quiz.example.com",
    WIDGET_DOMAIN: "https://quiz.example.com"
  };
}

function fakeJwt() {
  const now = Math.floor(Date.now() / 1000);
  return [
    base64UrlJson({ alg: "RS256", kid: "key-1" }),
    base64UrlJson({
      aud: "https://quiz.example.com",
      exp: now + 300,
      iss: "https://auth.example.com",
      scope: "quiz:render"
    }),
    "c2lnbmF0dXJl"
  ].join(".");
}

function base64UrlJson(value: unknown): string {
  return btoa(JSON.stringify(value))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function quizArgs(title: string) {
  return {
    title,
    questions: [
      {
        prompt: `${title} prompt`,
        answers: [
          { text: "Right", correct: true },
          { text: "Wrong", correct: false }
        ]
      }
    ]
  };
}
