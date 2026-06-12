const endpoint = new URL(process.env.MCP_URL || "http://127.0.0.1:8787/mcp");
const templateUri = "ui://widget/inline-quiz-v5.html";
const expectedWidgetDomain = process.env.EXPECTED_WIDGET_DOMAIN || "";
let nextId = 1;

const sampleQuiz = {
  title: "Smoke quiz",
  targetGradePercent: 80,
  questions: [
    {
      prompt: "Cloudflare Workers are deployed with which CLI?",
      answers: [
        { text: "Wrangler", correct: true, explanation: "Wrangler is Cloudflare's Worker CLI." },
        { text: "Cargo", correct: false },
        { text: "Pip", correct: false }
      ]
    },
    {
      prompt: "The server shuffles answer positions.",
      type: "true_false",
      answers: [
        { text: "True", correct: true },
        { text: "False", correct: false }
      ]
    }
  ]
};

await checkInitialize();
await checkToolDescriptor();
await checkWidgetResource();
await checkToolCall();
await checkNoAuthHttpSurface();

async function checkInitialize() {
  const result = await rpc("initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "smoke", version: "1.0.0" }
  });

  assert(result.serverInfo?.name === "quiz-mcp", "initialize should return the quiz-mcp server name.");
  console.log("initialize: ok");
}

async function checkToolDescriptor() {
  const result = await rpc("tools/list", {});
  const tool = result.tools?.find((candidate) => candidate?.name === "render_inline_quiz");

  assert(tool, "tools/list should include render_inline_quiz.");
  assertJsonEqual(tool.securitySchemes, [{ type: "noauth" }], "Tool must advertise noauth for the public no-auth deployment.");
  assertJsonEqual(tool._meta?.securitySchemes, [{ type: "noauth" }], "Tool _meta securitySchemes must also advertise noauth.");
  assert(tool._meta?.ui?.resourceUri === templateUri, `Tool UI resource must point at ${templateUri}.`);
  assert(tool._meta?.["openai/outputTemplate"] === templateUri, `Tool outputTemplate must point at ${templateUri}.`);
  assert(tool._meta?.["openai/widgetAccessible"] === true, "Widget must remain accessible to host bridge events.");
  assert(tool._meta?.["openai/visibility"] === "public", "No-auth deployment should remain public in Apps metadata.");

  console.log("tools/list: ok (noauth, v5 template)");
}

async function checkWidgetResource() {
  const result = await rpc("resources/read", { uri: templateUri });
  const content = result.contents?.[0];

  assert(content?.uri === templateUri, `resources/read should return ${templateUri}.`);
  assert(content.mimeType === "text/html;profile=mcp-app", "Widget resource must use the mcp-app HTML MIME type.");
  assert(typeof content.text === "string" && content.text.includes("quiz-root"), "Widget HTML should include the quiz root.");
  assertJsonEqual(content._meta?.ui?.csp?.connectDomains, [], "Widget UI CSP must not allow outbound connections.");
  assertJsonEqual(content._meta?.ui?.csp?.resourceDomains, [], "Widget UI CSP must not allow remote resources.");
  assertJsonEqual(content._meta?.["openai/widgetCSP"]?.connect_domains, [], "OpenAI widget CSP must not allow outbound connections.");
  assertJsonEqual(content._meta?.["openai/widgetCSP"]?.resource_domains, [], "OpenAI widget CSP must not allow remote resources.");

  const widgetDomain = content._meta?.["openai/widgetDomain"];
  assert(/^https:\/\/[^/]+$/.test(widgetDomain), "Widget domain must be an HTTPS origin with no path.");
  if (expectedWidgetDomain) {
    assert(widgetDomain === expectedWidgetDomain, `Widget domain should be ${expectedWidgetDomain}, got ${widgetDomain}.`);
  }

  console.log("resources/read: ok (strict widget CSP)");
}

async function checkToolCall() {
  const result = await rpc("tools/call", { name: "render_inline_quiz", arguments: sampleQuiz });

  assert(result.structuredContent?.title === sampleQuiz.title, "Tool result should include structured quiz content.");
  assert(result.structuredContent?.totalQuestions === sampleQuiz.questions.length, "Tool result should include every question.");
  assert(result._meta?.answerKey, "Answer key should be present only in hidden metadata.");
  assert(!JSON.stringify(result.structuredContent).includes("answerKey"), "Answer key must not leak into structuredContent.");

  console.log("tools/call: ok");
}

async function checkNoAuthHttpSurface() {
  const health = await fetchHttp("/healthz");
  assert(health.response.ok, `/healthz should be public in no-auth mode, got HTTP ${health.response.status}.`);
  assert(health.body?.ok === true, "/healthz should return ok: true.");
  assert(health.body?.widget === templateUri, `/healthz should advertise ${templateUri}.`);

  const metadata = await fetchHttp("/.well-known/oauth-protected-resource");
  assert(metadata.response.status === 404, "OAuth protected-resource metadata should be hidden when AUTH_MODE is none.");

  const root = await fetchHttp("/");
  assert(root.response.status === 404, "Root HTML should not be publicly served.");

  const widget = await fetchHttp("/widget/quiz.html", { raw: true });
  assert(widget.response.ok, `/widget/quiz.html should be public in no-auth mode, got HTTP ${widget.response.status}.`);
  assert(widget.response.headers.get("cache-control") === "no-store", "Widget route must not cache stale UI after deploys.");
  const csp = widget.response.headers.get("content-security-policy") || "";
  assert(csp.includes("default-src 'none'"), "Widget route CSP must default to no sources.");
  assert(csp.includes("connect-src 'none'"), "Widget route CSP must forbid outbound connections.");
  assert(csp.includes("frame-ancestors https://chatgpt.com https://chat.openai.com"), "Widget route CSP must restrict frame ancestors to ChatGPT.");
  assert(widget.body.includes('data-quiz-vendor="katex"'), "Widget route must embed the vendored KaTeX runtime.");
  assert(widget.body.includes("__QUIZ_ENABLE_WIDGET_STATE__"), "Widget route must keep host widget-state persistence gated.");

  console.log("no-auth HTTP surface: ok");
}

async function rpc(method, params) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params })
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${method} failed with HTTP ${response.status}: ${text}`);
  }

  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`${method} did not return JSON: ${text}`);
  }

  if (body.error || body.result?.isError) {
    throw new Error(`${method} returned an error: ${JSON.stringify(body)}`);
  }

  return body.result;
}

async function fetchHttp(path, options = {}) {
  const url = new URL(endpoint);
  url.pathname = path;
  url.search = "";
  url.hash = "";

  const response = await fetch(url);
  if (options.raw) {
    return { response, body: await response.text() };
  }

  const text = await response.text();
  try {
    return { response, body: text ? JSON.parse(text) : null };
  } catch {
    return { response, body: text };
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function assertJsonEqual(actual, expected, message) {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(`${message} Expected ${expectedJson}, got ${actualJson}.`);
  }
}
