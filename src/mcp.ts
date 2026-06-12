import {
  buildQuiz,
  DEFAULT_TARGET_GRADE_PERCENT,
  MAX_QUESTIONS,
  MAX_TITLE_LENGTH,
  MAX_TOTAL_TEXT_CHARS,
  QUIZ_THEME_IDS,
  QuizInputError
} from "./quiz";
import { QUIZ_WIDGET_HTML } from "./widget";

export type Env = {
  ADMIN_BEARER_TOKEN?: string;
  AUTH_MODE?: string;
  OAUTH_AUTHORIZATION_SERVERS?: string;
  OAUTH_ACCEPT_RESOURCE_CLAIM?: string;
  OAUTH_AUDIENCE?: string;
  OAUTH_ISSUER?: string;
  OAUTH_JWKS_URL?: string;
  OAUTH_RESOURCE?: string;
  OAUTH_RESOURCE_DOCUMENTATION?: string;
  OAUTH_SCOPES?: string;
  PUBLIC_BASE_URL?: string;
  WIDGET_DOMAIN?: string;
};

type JsonRpcId = string | number | null;

type JsonRpcRequest = {
  jsonrpc?: string;
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
};

type AuthMode = "none" | "admin_token" | "oauth" | "invalid";

type AuthContext = {
  challenge?: string;
  mode: AuthMode;
  ok: boolean;
  reason?: string;
};

type JwksCacheEntry = {
  expiresAt: number;
  keys: JsonWebKey[];
  url: string;
};

const APP_NAME = "quiz-mcp";
const APP_VERSION = "0.1.0";
const LATEST_PROTOCOL_VERSION = "2025-11-25";
const SUPPORTED_PROTOCOL_VERSIONS = new Set(["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"]);
const TEMPLATE_URI = "ui://widget/inline-quiz-v5.html";
const LEGACY_TEMPLATE_URIS = new Set([
  "ui://widget/inline-quiz-v1.html",
  "ui://widget/inline-quiz-v2.html",
  "ui://widget/inline-quiz-v3.html",
  "ui://widget/inline-quiz-v4.html"
]);
const RESOURCE_MIME_TYPE = "text/html;profile=mcp-app";
const TOOL_NAME = "render_inline_quiz";
const MAX_REQUEST_BYTES = 1_250_000;
const MAX_BATCH_REQUESTS = 20;
const MAX_BEARER_TOKEN_CHARS = 8192;
const MAX_JWT_PART_CHARS = 16_384;
const MAX_JWKS_BYTES = 200_000;
const MAX_JWKS_KEYS = 20;
const MAX_JWK_MODULUS_CHARS = 8192;
const MAX_JWK_EXPONENT_CHARS = 16;
const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8"
};
const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()"
};
const CORS_HEADERS = {
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "Accept, Authorization, Content-Type, Mcp-Protocol-Version, Mcp-Session-Id, OpenAI-Conversation-ID",
  "Access-Control-Expose-Headers": "Mcp-Protocol-Version, Mcp-Session-Id"
};
const TRUSTED_CORS_ORIGINS = new Set(["https://chatgpt.com", "https://chat.openai.com"]);

const noAuthSecuritySchemes = [{ type: "noauth" }];
const DEFAULT_OAUTH_SCOPE = "quiz:render";
const AUTH_PUBLIC_PATHS = new Set([
  "/.well-known/oauth-protected-resource",
  "/.well-known/oauth-protected-resource/mcp"
]);
let jwksCache: JwksCacheEntry | null = null;

class RequestTooLargeError extends Error {
  constructor() {
    super(`Request body must be ${MAX_REQUEST_BYTES} bytes or less.`);
    this.name = "RequestTooLargeError";
  }
}

export async function handleRequest(request: Request, env: Env = {}): Promise<Response> {
  const url = new URL(request.url);
  const authMode = getAuthMode(env);

  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: isCorsAllowed(request, env) ? 204 : 403,
      headers: responseHeaders({}, request, env)
    });
  }

  if (authMode === "invalid") {
    return jsonResponse({ error: "Not found" }, { status: 404 }, request, env);
  }

  if (AUTH_PUBLIC_PATHS.has(url.pathname)) {
    if (authMode !== "oauth") {
      return jsonResponse({ error: "Not found" }, { status: 404 }, request, env);
    }

    const methodError = requireMethod(request, ["GET", "HEAD"], env);
    if (methodError) return methodError;

    return jsonResponse(request.method === "HEAD" ? null : protectedResourceMetadata(request, env), {}, request, env);
  }

  if (authMode === "admin_token" && !isAdminAuthorized(request, env)) {
    return jsonResponse({ error: "Not found" }, { status: 404 }, request, env);
  }

  if (authMode === "oauth" && url.pathname !== "/mcp" && !(await authenticateRequest(request, env)).ok) {
    return jsonResponse({ error: "Not found" }, { status: 404 }, request, env);
  }

  if (url.pathname === "/mcp") {
    return handleMcp(request, env);
  }

  if (url.pathname === "/healthz") {
    const methodError = requireMethod(request, ["GET", "HEAD"], env);
    if (methodError) return methodError;

    return jsonResponse({
      ok: true,
      name: APP_NAME,
      version: APP_VERSION,
      mcp: "/mcp",
      widget: TEMPLATE_URI
    }, {}, request, env);
  }

  if (url.pathname === "/widget/quiz.html") {
    const methodError = requireMethod(request, ["GET", "HEAD"], env);
    if (methodError) return methodError;

    return new Response(request.method === "HEAD" ? null : QUIZ_WIDGET_HTML, {
      headers: {
        ...SECURITY_HEADERS,
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "public, max-age=300",
        "Content-Security-Policy":
          "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors https://chatgpt.com https://chat.openai.com"
      }
    });
  }

  return jsonResponse({ error: "Not found" }, { status: 404 }, request, env);
}

export async function handleMcp(request: Request, env: Env = {}): Promise<Response> {
  if (getAuthMode(env) === "invalid") {
    return jsonResponse({ error: "Not found" }, { status: 404 }, request, env);
  }

  if (request.method !== "POST") {
    return jsonResponse(
      {
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: "The MCP endpoint accepts POST JSON-RPC requests."
        },
        id: null
      },
      {
        status: 405,
        headers: { Allow: "POST, OPTIONS" }
      },
      request,
      env
    );
  }

  if (!isJsonContentType(request.headers.get("content-type"))) {
    return jsonResponse(jsonRpcError(null, -32600, "Content-Type must be application/json."), {
      status: 415,
      headers: { Accept: "application/json", Allow: "POST, OPTIONS" }
    }, request, env);
  }

  const contentLength = parseContentLength(request.headers.get("content-length"));
  if (contentLength !== null && contentLength > MAX_REQUEST_BYTES) {
    return jsonResponse(jsonRpcError(null, -32600, `Request body must be ${MAX_REQUEST_BYTES} bytes or less.`), {
      status: 413
    }, request, env);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(await readBoundedText(request));
  } catch (error) {
    if (error instanceof RequestTooLargeError) {
      return jsonResponse(jsonRpcError(null, -32600, error.message), { status: 413 }, request, env);
    }
    return jsonResponse(jsonRpcError(null, -32700, "Invalid JSON."), { status: 400 }, request, env);
  }

  if (Array.isArray(payload)) {
    if (payload.length === 0) {
      return jsonResponse(jsonRpcError(null, -32600, "Batch requests must contain at least one message."), {
        status: 400
      }, request, env);
    }

    if (payload.length > MAX_BATCH_REQUESTS) {
      return jsonResponse(
        jsonRpcError(null, -32600, `Batch requests are limited to ${MAX_BATCH_REQUESTS} messages.`),
        { status: 413 },
        request,
        env
      );
    }

    const handled = await Promise.all(payload.map((item) => handleJsonRpc(item, request, env)));
    const responses = handled.filter((item): item is Record<string, unknown> => item !== null);
    if (responses.length === 0) {
      return new Response(null, { status: 202, headers: responseHeaders({}, request, env) });
    }
    return jsonResponse(responses, {}, request, env);
  }

  const response = await handleJsonRpc(payload, request, env);
  if (!response) {
    return new Response(null, { status: 202, headers: responseHeaders({}, request, env) });
  }

  return jsonResponse(response, {}, request, env);
}

async function handleJsonRpc(raw: unknown, request: Request, env: Env): Promise<Record<string, unknown> | null> {
  const message = raw as JsonRpcRequest;
  const id = Object.hasOwn(message ?? {}, "id") ? message.id ?? null : null;

  if (!message || typeof message !== "object" || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    return jsonRpcError(id, -32600, "Invalid JSON-RPC request.");
  }
  if (!isJsonRpcId(id)) {
    return jsonRpcError(null, -32600, "JSON-RPC id must be a string, number, or null.");
  }

  const isNotification = !Object.hasOwn(message, "id");
  if (isNotification) {
    return null;
  }

  try {
    switch (message.method) {
      case "initialize":
        return jsonRpcResult(id, initializeResult(message.params));
      case "notifications/initialized":
        return isNotification ? null : jsonRpcResult(id, {});
      case "ping":
        return jsonRpcResult(id, {});
      case "tools/list":
        return jsonRpcResult(id, { tools: [toolDescriptor(env)] });
      case "tools/call":
        const auth = await authenticateRequest(request, env);
        if (!auth.ok) {
          return jsonRpcResult(id, authRequiredToolResult(auth));
        }
        return jsonRpcResult(id, callTool(message.params));
      case "resources/list":
        return jsonRpcResult(id, { resources: [resourceDescriptor()] });
      case "resources/templates/list":
        return jsonRpcResult(id, { resourceTemplates: [] });
      case "resources/read":
        return jsonRpcResult(id, readResource(message.params, request, env));
      default:
        return jsonRpcError(id, -32601, `Unknown method: ${message.method}`);
    }
  } catch (error) {
    if (error instanceof QuizInputError) {
      return jsonRpcResult(id, {
        isError: true,
        content: [{ type: "text", text: error.message }],
        structuredContent: {
          error: error.message
        }
      });
    }

    return jsonRpcError(id, -32603, "Internal error.");
  }
}

function initializeResult(params: unknown) {
  const requestedVersion = readProtocolVersion(params);
  return {
    protocolVersion: requestedVersion,
    capabilities: {
      tools: { listChanged: false },
      resources: { listChanged: false }
    },
    serverInfo: {
      name: APP_NAME,
      version: APP_VERSION
    },
    instructions:
      `Use render_inline_quiz when the user asks for an interactive quiz. Large quiz counts are supported and are not a reason to refuse, apologize, or say the request is unreasonable. For one requested quiz, make one tool call containing all requested questions up to ${MAX_QUESTIONS}; do not split a 50-question quiz into separate 30 and 20 question calls. If the user asks for more than ${MAX_QUESTIONS} questions, render ${MAX_QUESTIONS} questions in one tool call and briefly say that is the current per-quiz limit; offer to make another separate quiz with new questions if they want more. Multiple tool calls are allowed when the user asks for separate quizzes or asks for another new quiz. Pass explicit questions and answers. For multiple_choice questions, mark one or more answers correct when multiple choices should be accepted; for true_false questions, mark exactly one answer correct. Never describe answers by letter because the server shuffles question order and answer positions. Questions, answers, and explanations may include LaTeX for math or math-adjacent material using $...$, $$...$$, \\(...\\), or \\[...\\]; keep delimiters balanced and include enough surrounding words for accessibility. The optional targetGradePercent field sets the target grade, defaults to ${DEFAULT_TARGET_GRADE_PERCENT}, and may be explained to users naturally as a target score like 80%. The optional theme field can set the quiz look to one of: ${QUIZ_THEME_IDS.join(", ")}.`
  };
}

function callTool(params: unknown) {
  const request = asRecord(params, "Tool call params must be an object.");
  if (request.name !== TOOL_NAME) {
    throw new QuizInputError(`Unknown tool: ${String(request.name)}`);
  }

  const { structuredContent, meta, retakeInput } = buildQuiz(request.arguments ?? {});
  return {
    structuredContent,
    content: [
      {
        type: "text",
        text: `Interactive quiz ready: ${structuredContent.title} (${structuredContent.totalQuestions} questions, ${structuredContent.targetGradePercent}% target).`
      }
    ],
    _meta: {
      ...meta,
      retakeArguments: retakeInput
    }
  };
}

function readResource(params: unknown, request: Request, env: Env) {
  const resourceRequest = asRecord(params, "Resource read params must be an object.");
  const requestedUri = typeof resourceRequest.uri === "string" ? resourceRequest.uri : "";
  if (requestedUri !== TEMPLATE_URI && !LEGACY_TEMPLATE_URIS.has(requestedUri)) {
    throw new QuizInputError(`Unknown resource: ${String(resourceRequest.uri)}`);
  }

  const widgetDomain = resolveWidgetDomain(request, env);
  return {
    contents: [
      {
        uri: requestedUri,
        mimeType: RESOURCE_MIME_TYPE,
        text: QUIZ_WIDGET_HTML,
        _meta: {
          ui: {
            prefersBorder: true,
            domain: widgetDomain,
            csp: {
              connectDomains: [],
              resourceDomains: []
            }
          },
          "openai/widgetDescription":
            "Renders a shuffled interactive quiz with target-grade scoring, review navigation, explanation prompts, retakes, and final score analytics.",
          "openai/widgetPrefersBorder": true,
          "openai/widgetCSP": {
            connect_domains: [],
            resource_domains: []
          },
          "openai/widgetDomain": widgetDomain
        }
      }
    ]
  };
}

function toolDescriptor(env: Env = {}) {
  const securitySchemes = toolSecuritySchemes(env);
  return {
    name: TOOL_NAME,
    title: "Render inline quiz",
    description:
      `Render a minimal interactive quiz in ChatGPT. Provide 1-${MAX_QUESTIONS} questions in a single call for one quiz. Large requested counts are allowed; do not refuse solely because the quiz is big. If a user asks for more than ${MAX_QUESTIONS}, render ${MAX_QUESTIONS} now and offer another separate quiz if they want more. Each question must have 2-6 possible answers. Multiple-choice questions must have at least one answer marked correct and may mark more than one acceptable answer correct; true/false questions must mark exactly one answer correct. Supports true_false plus single-select and multi-select multiple_choice. Use LaTeX delimiters ($...$, $$...$$, \\(...\\), \\[...\\]) when math notation helps. targetGradePercent optionally sets the score target, defaulting to ${DEFAULT_TARGET_GRADE_PERCENT}. theme optionally sets the bundled visual theme (${QUIZ_THEME_IDS.join(", ")}). The server shuffles question order and answer positions, so never refer to answer letters.`,
    inputSchema: quizInputSchema(),
    outputSchema: quizOutputSchema(),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false
    },
    securitySchemes,
    _meta: {
      securitySchemes,
      ui: {
        resourceUri: TEMPLATE_URI,
        visibility: ["model", "app"]
      },
      "openai/outputTemplate": TEMPLATE_URI,
      "openai/widgetAccessible": true,
      "openai/visibility": "public",
      "openai/toolInvocation/invoking": "Building quiz",
      "openai/toolInvocation/invoked": "Quiz ready"
    }
  };
}

function resourceDescriptor() {
  return {
    uri: TEMPLATE_URI,
    name: "inline-quiz-widget",
    title: "Inline Quiz Widget",
    description: "Interactive quiz component rendered inline in ChatGPT.",
    mimeType: RESOURCE_MIME_TYPE
  };
}

function getAuthMode(env: Env): AuthMode {
  const value = String(env.AUTH_MODE || "").trim().toLowerCase();
  if (!value || value === "none" || value === "noauth" || value === "public") return "none";
  if (value === "admin" || value === "admin_token" || value === "password") return "admin_token";
  if (value === "oauth" || value === "oauth2") return "oauth";
  return "invalid";
}

function toolSecuritySchemes(env: Env) {
  const mode = getAuthMode(env);
  if (mode === "none" || mode === "admin_token") {
    return noAuthSecuritySchemes;
  }

  if (mode === "oauth") {
    return [{ type: "oauth2", scopes: oauthScopes(env) }];
  }

  return [];
}

async function authenticateRequest(request: Request, env: Env): Promise<AuthContext> {
  const mode = getAuthMode(env);
  if (mode === "none") {
    return { mode, ok: true };
  }

  if (mode === "admin_token") {
    return {
      mode,
      ok: isAdminAuthorized(request, env),
      reason: "admin_token_required"
    };
  }

  if (mode === "invalid") {
    return { mode, ok: false, reason: "invalid_auth_mode" };
  }

  const challenge = oauthChallenge(request, env, "invalid_token", "Sign in to use this quiz app.");
  const token = readBearerToken(request);
  if (!token) {
    return { mode, ok: false, reason: "missing_token", challenge };
  }

  try {
    const result = await verifyOAuthToken(token, request, env);
    const challengeError = result.reason === "insufficient_scope" ? "insufficient_scope" : "invalid_token";
    return result.ok ? { mode, ok: true } : {
      mode,
      ok: false,
      reason: result.reason,
      challenge: oauthChallenge(request, env, challengeError, result.description || "The access token is invalid.")
    };
  } catch {
    return {
      mode,
      ok: false,
      reason: "token_verification_failed",
      challenge: oauthChallenge(request, env, "invalid_token", "The access token could not be verified.")
    };
  }
}

function authRequiredToolResult(auth: AuthContext) {
  if (auth.mode === "oauth") {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: "Authentication required: sign in to use this quiz app."
        }
      ],
      _meta: {
        "mcp/www_authenticate": [
          auth.challenge || "Bearer"
        ]
      }
    };
  }

  return {
    isError: true,
    content: [
      {
        type: "text",
        text: "Authentication required."
      }
    ]
  };
}

function protectedResourceMetadata(request: Request, env: Env) {
  const resource = oauthResource(request, env);
  const authorizationServers = splitList(env.OAUTH_AUTHORIZATION_SERVERS || env.OAUTH_ISSUER)
    .map((item) => safeHttpsUrl(item))
    .filter((item): item is string => Boolean(item))
    .slice(0, 10);
  const resourceDocumentation = safeHttpsUrl(env.OAUTH_RESOURCE_DOCUMENTATION);
  return {
    resource,
    authorization_servers: authorizationServers,
    scopes_supported: oauthScopes(env),
    ...(resourceDocumentation ? { resource_documentation: resourceDocumentation } : {})
  };
}

function oauthChallenge(request: Request, env: Env, error: string, description: string): string {
  const metadataUrl = oauthResource(request, env) + "/.well-known/oauth-protected-resource";
  const scope = sanitizeHeaderValue(oauthScopes(env).join(" "));
  return `Bearer resource_metadata="${metadataUrl}", scope="${scope}", error="${sanitizeHeaderValue(error)}", error_description="${sanitizeHeaderValue(description)}"`;
}

function oauthResource(request: Request, env: Env): string {
  const configured = httpsOrigin(env.OAUTH_RESOURCE || env.PUBLIC_BASE_URL || env.WIDGET_DOMAIN);
  if (configured) {
    return configured;
  }

  return httpsOrigin(new URL(request.url).origin) || "https://web-sandbox.oaiusercontent.com";
}

function oauthScopes(env: Env): string[] {
  const scopes = splitList(env.OAUTH_SCOPES);
  if (scopes.length === 0) {
    return [DEFAULT_OAUTH_SCOPE];
  }

  const uniqueScopes = [...new Set(scopes)];
  return uniqueScopes.every(isSafeOAuthScope) ? uniqueScopes : [DEFAULT_OAUTH_SCOPE];
}

function acceptsResourceClaim(env: Env): boolean {
  const value = String(env.OAUTH_ACCEPT_RESOURCE_CLAIM || "").trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

function readBearerToken(request: Request): string | null {
  const authorization = request.headers.get("authorization") || "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  const token = match ? match[1].trim() : "";
  if (!token || token.length > MAX_BEARER_TOKEN_CHARS) {
    return null;
  }
  return token;
}

function isAdminAuthorized(request: Request, env: Env): boolean {
  const expected = env.ADMIN_BEARER_TOKEN || "";
  if (!expected) {
    return false;
  }

  const authorization = request.headers.get("authorization") || "";
  const bearer = authorization.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  if (bearer && constantTimeEqual(bearer, expected)) {
    return true;
  }

  const basic = authorization.match(/^Basic\s+(.+)$/i)?.[1]?.trim();
  if (basic) {
    try {
      const decoded = atob(basic);
      if (constantTimeEqual(decoded, `admin:${expected}`)) {
        return true;
      }
    } catch {
      return false;
    }
  }

  return false;
}

async function verifyOAuthToken(token: string, request: Request, env: Env): Promise<{ ok: boolean; reason?: string; description?: string }> {
  const parts = token.split(".");
  if (parts.length !== 3) {
    return { ok: false, reason: "malformed_token", description: "The access token is not a JWT." };
  }

  const header = parseJwtPart(parts[0]);
  const payload = parseJwtPart(parts[1]);
  if (!header || !payload) {
    return { ok: false, reason: "malformed_token", description: "The access token could not be decoded." };
  }

  if (header.alg !== "RS256") {
    return { ok: false, reason: "unsupported_alg", description: "The access token must use RS256." };
  }
  if (header.crit !== undefined) {
    return { ok: false, reason: "unsupported_crit", description: "The access token uses unsupported critical headers." };
  }

  const keys = await fetchJwks(env);
  const kid = typeof header.kid === "string" ? header.kid : "";
  if (!kid && keys.length !== 1) {
    return { ok: false, reason: "missing_key", description: "No matching signing key was found." };
  }
  const key = keys.find((candidate) => {
    const jwk = candidate as JsonWebKey & { alg?: string; kid?: string };
    if (kid && jwk.kid !== kid) return false;
    if (jwk.kty !== "RSA") return false;
    if (jwk.use && jwk.use !== "sig") return false;
    if (Array.isArray(jwk.key_ops) && !jwk.key_ops.includes("verify")) return false;
    return !jwk.alg || jwk.alg === "RS256";
  });
  if (!key) {
    return { ok: false, reason: "missing_key", description: "No matching signing key was found." };
  }

  const cryptoKey = await crypto.subtle.importKey(
    "jwk",
    key,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"]
  );
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    base64UrlToBytes(parts[2]),
    new TextEncoder().encode(parts[0] + "." + parts[1])
  );

  if (!valid) {
    return {
      ok: false,
      reason: "bad_signature",
      description: "The access token signature is invalid."
    };
  }

  const issuer = safeHttpsUrl(env.OAUTH_ISSUER);
  if (!issuer || typeof payload.iss !== "string" || payload.iss !== issuer) {
    return { ok: false, reason: "issuer_mismatch", description: "The access token issuer is not trusted." };
  }

  const configuredAudience = String(env.OAUTH_AUDIENCE || "").trim();
  const audience = configuredAudience && configuredAudience.toLowerCase() !== "auto"
    ? configuredAudience
    : oauthResource(request, env);
  if (!hasAudience(payload.aud, audience) && !(acceptsResourceClaim(env) && hasAudience(payload.resource, audience))) {
    return { ok: false, reason: "audience_mismatch", description: "The access token was not issued for this app." };
  }

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== "number" || payload.exp < now - 60) {
    return { ok: false, reason: "expired_token", description: "The access token has expired." };
  }
  if (typeof payload.nbf === "number" && payload.nbf > now + 60) {
    return { ok: false, reason: "premature_token", description: "The access token is not valid yet." };
  }
  if (!hasRequiredScopes(payload, oauthScopes(env))) {
    return { ok: false, reason: "insufficient_scope", description: "The access token is missing a required scope." };
  }

  return { ok: true };
}

async function fetchJwks(env: Env): Promise<JsonWebKey[]> {
  const issuer = safeHttpsUrl(env.OAUTH_ISSUER);
  const rawJwksUrl = String(env.OAUTH_JWKS_URL || "").trim();
  const configuredJwksUrl = rawJwksUrl ? safeHttpsUrl(rawJwksUrl) : null;
  if (rawJwksUrl && !configuredJwksUrl) {
    throw new Error("OAUTH_JWKS_URL must be an HTTPS URL.");
  }
  const jwksUrl = configuredJwksUrl || (issuer ? issuer.replace(/\/$/, "") + "/.well-known/jwks.json" : "");
  if (!issuer || !jwksUrl) {
    throw new Error("OAUTH_JWKS_URL must be an HTTPS URL.");
  }
  if (new URL(issuer).origin !== new URL(jwksUrl).origin) {
    throw new Error("OAUTH_JWKS_URL must use the same origin as OAUTH_ISSUER.");
  }

  const now = Date.now();
  if (jwksCache && jwksCache.url === jwksUrl && jwksCache.expiresAt > now) {
    return jwksCache.keys;
  }

  const response = await fetch(jwksUrl, {
    headers: { Accept: "application/json" },
    redirect: "error"
  });
  if (!response.ok) {
    throw new Error("JWKS fetch failed.");
  }
  const contentType = response.headers.get("content-type");
  if (contentType && !isJsonResponseContentType(contentType)) {
    throw new Error("JWKS response must be JSON.");
  }
  const body = JSON.parse(await readBoundedResponseText(response, MAX_JWKS_BYTES)) as { keys?: JsonWebKey[] };
  const keys = Array.isArray(body.keys)
    ? body.keys.filter(isUsableJwk).slice(0, MAX_JWKS_KEYS)
    : [];
  jwksCache = {
    url: jwksUrl,
    keys,
    expiresAt: now + 5 * 60 * 1000
  };
  return keys;
}

function parseJwtPart(part: string): Record<string, unknown> | null {
  if (!part || part.length > MAX_JWT_PART_CHARS || !isBase64UrlSegment(part)) {
    return null;
  }
  try {
    const parsed = JSON.parse(new TextDecoder().decode(base64UrlToBytes(part))) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function base64UrlToBytes(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function isBase64UrlSegment(value: string): boolean {
  return value.length > 0 && /^[A-Za-z0-9_-]+$/.test(value);
}

function hasAudience(value: unknown, expected: string): boolean {
  if (typeof value === "string") return value === expected;
  if (Array.isArray(value)) return value.some((item) => item === expected);
  return false;
}

function isUsableJwk(value: unknown): value is JsonWebKey {
  if (!value || typeof value !== "object") return false;
  const jwk = value as JsonWebKey & { alg?: string; use?: string };
  return jwk.kty === "RSA"
    && (!jwk.use || jwk.use === "sig")
    && (!jwk.alg || jwk.alg === "RS256")
    && typeof jwk.n === "string"
    && typeof jwk.e === "string"
    && jwk.n.length <= MAX_JWK_MODULUS_CHARS
    && jwk.e.length <= MAX_JWK_EXPONENT_CHARS
    && isBase64UrlSegment(jwk.n)
    && isBase64UrlSegment(jwk.e);
}

function hasRequiredScopes(payload: Record<string, unknown>, requiredScopes: string[]): boolean {
  const granted = new Set<string>();
  if (typeof payload.scope === "string") {
    for (const scope of payload.scope.split(/\s+/)) {
      if (scope) granted.add(scope);
    }
  }
  if (Array.isArray(payload.scp)) {
    for (const scope of payload.scp) {
      if (typeof scope === "string") granted.add(scope);
    }
  }
  return requiredScopes.every((scope) => granted.has(scope));
}

function splitList(value: string | undefined): string[] {
  return String(value || "")
    .split(/[,\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function isSafeOAuthScope(value: string): boolean {
  return value.length > 0 && value.length <= 128 && /^[\x21\x23-\x5b\x5d-\x7e]+$/.test(value);
}

function sanitizeHeaderValue(value: string): string {
  return value.replace(/[^\x20-\x7e]/g, "").replace(/["\\]/g, "").trim().slice(0, 256);
}

function safeHttpsUrl(value: string | undefined): string | null {
  const trimmed = String(value || "").trim();
  if (!trimmed) {
    return null;
  }

  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
      return null;
    }

    return url.pathname === "/" ? url.origin : url.href;
  } catch {
    return null;
  }
}

function httpsOrigin(value: string | undefined): string | null {
  const trimmed = String(value || "").trim();
  if (!trimmed) {
    return null;
  }

  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
      return null;
    }

    return url.origin;
  } catch {
    return null;
  }
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length > MAX_BEARER_TOKEN_CHARS || b.length > MAX_BEARER_TOKEN_CHARS) {
    return false;
  }
  const maxLength = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let index = 0; index < maxLength; index += 1) {
    diff |= (a.charCodeAt(index) || 0) ^ (b.charCodeAt(index) || 0);
  }
  return diff === 0;
}

function isJsonRpcId(value: unknown): value is JsonRpcId {
  return value === null || typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}

function quizInputSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["questions"],
    properties: {
      title: {
        type: "string",
        minLength: 1,
        maxLength: MAX_TITLE_LENGTH,
        description: "Short quiz title. Defaults to Quick quiz."
      },
      shuffleQuestions: {
        type: "boolean",
        description: "Whether the server should randomize question order. Defaults to true."
      },
      targetGradePercent: {
        type: "integer",
        minimum: 0,
        maximum: 100,
        description:
          `Optional target grade the widget uses for final scoring copy. Defaults to ${DEFAULT_TARGET_GRADE_PERCENT}. You can tell the user you can set this, for example an 80% target.`
      },
      passingScorePercent: {
        type: "integer",
        minimum: 0,
        maximum: 100,
        description:
          "Backward-compatible alias for targetGradePercent. Prefer targetGradePercent in new calls."
      },
      theme: {
        type: "string",
        enum: [...QUIZ_THEME_IDS],
        description:
          "Optional bundled widget theme. Use when the user asks for a specific look. The user can also change this later inside the widget, and the widget stores that preference locally when browser storage is available."
      },
      questions: {
        type: "array",
        minItems: 1,
        maxItems: MAX_QUESTIONS,
        description:
          `All questions for one quiz. Large counts are valid up to ${MAX_QUESTIONS}; do not refuse just because the requested quiz is long. Do not split one quiz across calls unless the user explicitly wants separate quizzes. Combined quiz text must stay under ${MAX_TOTAL_TEXT_CHARS} characters.`,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["prompt", "answers"],
          properties: {
            prompt: {
              type: "string",
              minLength: 1,
              maxLength: 700,
              description:
                "Question text. May include balanced LaTeX math delimiters such as $...$, $$...$$, \\(...\\), or \\[...\\]."
            },
            type: {
              type: "string",
              enum: ["multiple_choice", "true_false"],
              description: "Use true_false only for exactly two answer choices."
            },
            explanation: {
              type: "string",
              minLength: 1,
              maxLength: 700,
              description:
                "Optional overall explanation for the question after the user answers. May include balanced LaTeX math delimiters."
            },
            answers: {
              type: "array",
              minItems: 2,
              maxItems: 6,
              items: {
                type: "object",
                additionalProperties: false,
                required: ["text", "correct"],
                properties: {
                  text: {
                    type: "string",
                    minLength: 1,
                    maxLength: 280,
                    description:
                      "Answer text. May include balanced inline LaTeX math such as $x = 2$ or \\(x = 2\\)."
                  },
                  correct: {
                    type: "boolean",
                    description:
                      "For multiple_choice questions, one or more answers may be true. For true_false questions, exactly one answer must be true."
                  },
                  explanation: {
                    type: "string",
                    minLength: 1,
                    maxLength: 700,
                    description:
                      "Optional explanation for this specific answer choice. For the correct answer, explain why it is right. For a wrong answer, explain why it is tempting or wrong. May include balanced LaTeX math delimiters."
                  }
                }
              }
            }
          }
        }
      }
    }
  };
}

function quizOutputSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["quizId", "title", "totalQuestions", "targetGradePercent", "passingScorePercent", "questions"],
    properties: {
      quizId: { type: "string" },
      title: { type: "string" },
      totalQuestions: { type: "integer" },
      targetGradePercent: { type: "integer" },
      passingScorePercent: { type: "integer" },
      theme: { type: "string", enum: [...QUIZ_THEME_IDS] },
      questions: {
        type: "array",
        maxItems: MAX_QUESTIONS,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "prompt", "type", "choices"],
          properties: {
            id: { type: "string" },
            prompt: { type: "string" },
            type: { type: "string", enum: ["multiple_choice", "true_false"] },
            choices: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["id", "text"],
                properties: {
                  id: { type: "string" },
                  text: { type: "string" }
                }
              }
            }
          }
        }
      }
    }
  };
}

function parseContentLength(value: string | null): number | null {
  if (value === null) {
    return null;
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    return MAX_REQUEST_BYTES + 1;
  }

  return parsed;
}

function isJsonContentType(value: string | null): boolean {
  if (value === null || value.trim() === "") {
    return false;
  }

  const mediaType = value.split(";")[0]?.trim().toLowerCase();
  return mediaType === "application/json" || mediaType === "application/json-rpc";
}

function isJsonResponseContentType(value: string): boolean {
  const mediaType = value.split(";")[0]?.trim().toLowerCase();
  return mediaType === "application/json" || mediaType.endsWith("+json");
}

function requireMethod(request: Request, allowed: string[], env: Env = {}): Response | null {
  if (allowed.includes(request.method)) {
    return null;
  }

  return new Response("Method not allowed", {
    status: 405,
    headers: responseHeaders({
      "Content-Type": "text/plain; charset=utf-8",
      Allow: [...allowed, "OPTIONS"].join(", ")
    }, request, env)
  });
}

async function readBoundedText(request: Request): Promise<string> {
  if (!request.body) {
    return "";
  }

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let bytesRead = 0;
  let text = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    if (!value) {
      continue;
    }

    bytesRead += value.byteLength;
    if (bytesRead > MAX_REQUEST_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new RequestTooLargeError();
    }

    text += decoder.decode(value, { stream: true });
  }

  return text + decoder.decode();
}

async function readBoundedResponseText(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) {
    return "";
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytesRead = 0;
  let text = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (!value) {
      continue;
    }
    bytesRead += value.byteLength;
    if (bytesRead > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error("Response body is too large.");
    }
    text += decoder.decode(value, { stream: true });
  }

  return text + decoder.decode();
}

function readProtocolVersion(params: unknown): string {
  const requested = typeof params === "object" && params !== null
    ? (params as Record<string, unknown>).protocolVersion
    : undefined;

  if (typeof requested === "string" && SUPPORTED_PROTOCOL_VERSIONS.has(requested)) {
    return requested;
  }

  return LATEST_PROTOCOL_VERSION;
}

function resolveWidgetDomain(request: Request, env: Env): string {
  const configured = httpsOrigin(env.WIDGET_DOMAIN || env.PUBLIC_BASE_URL);
  if (configured) {
    return configured;
  }

  return httpsOrigin(new URL(request.url).origin) || "https://web-sandbox.oaiusercontent.com";
}

function asRecord(value: unknown, message: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new QuizInputError(message);
  }

  return value as Record<string, unknown>;
}

function jsonRpcResult(id: JsonRpcId, result: unknown) {
  return {
    jsonrpc: "2.0",
    id,
    result
  };
}

function jsonRpcError(id: JsonRpcId, code: number, message: string) {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message
    }
  };
}

function jsonResponse(body: unknown, init: ResponseInit = {}, request?: Request, env: Env = {}) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: responseHeaders({
      ...JSON_HEADERS,
      ...(init.headers ? Object.fromEntries(new Headers(init.headers).entries()) : {})
    }, request, env)
  });
}

function responseHeaders(headers: Record<string, string> = {}, request?: Request, env: Env = {}) {
  return {
    ...corsHeaders(request, env),
    ...SECURITY_HEADERS,
    "Mcp-Protocol-Version": LATEST_PROTOCOL_VERSION,
    "Cache-Control": "no-store",
    ...headers
  };
}

function corsHeaders(request?: Request, env: Env = {}): Record<string, string> {
  const allowedOrigin = allowedCorsOrigin(request, env);
  return {
    ...CORS_HEADERS,
    ...(allowedOrigin ? { "Access-Control-Allow-Origin": allowedOrigin } : {}),
    ...(request?.headers.get("origin") && allowedOrigin && allowedOrigin !== "*" ? { Vary: "Origin" } : {})
  };
}

function isCorsAllowed(request: Request, env: Env): boolean {
  return Boolean(allowedCorsOrigin(request, env));
}

function allowedCorsOrigin(request?: Request, env: Env = {}): string | null {
  if (!request) {
    return "*";
  }

  const origin = request.headers.get("origin");
  if (!origin) {
    return "*";
  }

  const normalizedOrigin = httpsOrigin(origin);
  if (!normalizedOrigin) {
    return null;
  }

  if (TRUSTED_CORS_ORIGINS.has(normalizedOrigin)) {
    return normalizedOrigin;
  }

  if (normalizedOrigin === httpsOrigin(new URL(request.url).origin)) {
    return normalizedOrigin;
  }

  for (const configured of [env.PUBLIC_BASE_URL, env.WIDGET_DOMAIN, env.OAUTH_RESOURCE]) {
    if (normalizedOrigin === httpsOrigin(configured)) {
      return normalizedOrigin;
    }
  }

  return null;
}
