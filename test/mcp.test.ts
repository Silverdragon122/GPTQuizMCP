import { describe, expect, it } from "vitest";
import { handleRequest } from "../src";
import { MAX_QUESTIONS, QUIZ_THEME_IDS } from "../src/quiz";

describe("mcp endpoint", () => {
  it("lists the render tool with Apps SDK component metadata", async () => {
    const response = await rpc("tools/list");
    const body = await response.json() as any;
    const tool = body.result.tools[0];

    expect(tool.name).toBe("render_inline_quiz");
    expect(tool.securitySchemes).toEqual([{ type: "noauth" }]);
    expect(tool.annotations.readOnlyHint).toBe(true);
    expect(tool._meta.ui.resourceUri).toBe("ui://widget/inline-quiz-v15.html");
    expect(tool._meta["openai/outputTemplate"]).toBe("ui://widget/inline-quiz-v15.html");
    expect(tool.description).toContain("one call");
    expect(tool.description).toContain("do not refuse");
    expect(tool.description).toContain("may mark multiple correct");
    expect(tool.description).toContain("true_false exactly one");
    expect(tool.description).toContain("matching needs 2-10 unique pairs");
    expect(tool.description).toContain("sorting needs 2-10 unique ordered items");
    expect(tool.description).toContain("partial credit");
    expect(tool.description).toContain("compact input");
    expect(tool.description).toContain("omit c/correct when false");
    expect(tool.description).toContain("fair/non-signaling");
    expect(tool.description).toContain("LaTeX");
    expect(tool.description).toContain("themes");
    expect(tool.inputSchema.properties.questions.maxItems).toBe(MAX_QUESTIONS);
    expect(tool.inputSchema.properties.questions.items.properties.prompt.description).toContain("LaTeX");
    expect(tool.inputSchema.properties.questions.items.properties.q.description).toContain("Compact alias");
    expect(tool.inputSchema.properties.questions.items.properties.a.description).toContain("Compact alias");
    expect(tool.inputSchema.properties.questions.items.properties.answers.description).toContain("parallel in length");
    expect(tool.inputSchema.properties.questions.items.properties.answers.items.anyOf).toEqual([
      { required: ["text"] },
      { required: ["t"] }
    ]);
    expect(tool.inputSchema.properties.questions.items.properties.answers.items.required).toBeUndefined();
    expect(tool.inputSchema.properties.questions.items.properties.answers.items.properties.c.description).toContain("omit when false");
    expect(tool.inputSchema.properties.questions.items.properties.p.description).toContain("matching pairs");
    expect(tool.inputSchema.properties.questions.items.properties.i.description).toContain("sorting items");
    expect(tool.inputSchema.properties.questions.items.properties.answers.items.properties.text.description).toContain("not guessable from style");
    expect(tool.inputSchema.properties.targetGradePercent).toBeDefined();
    expect(tool.inputSchema.properties.theme.enum).toEqual([...QUIZ_THEME_IDS]);
  });

  it("instructs the model not to refuse large quiz counts", async () => {
    const response = await rpc("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "test", version: "1.0.0" }
    });
    const body = await response.json() as any;

    expect(body.result.instructions).toContain("large counts are supported");
    expect(body.result.instructions).toContain("not a refusal reason");
    expect(body.result.instructions).toContain("one or more correct choices");
    expect(body.result.instructions).toContain("true_false needs exactly one");
    expect(body.result.instructions).toContain("compact input");
    expect(body.result.instructions).toContain("omit c/correct when false");
    expect(body.result.instructions).toContain("fair/non-signaling");
    expect(body.result.instructions).toContain("all/none-of-the-above shortcuts");
    expect(body.result.instructions).toContain(`more than ${MAX_QUESTIONS}`);
    expect(body.result.instructions).toContain("LaTeX");
    expect(body.result.instructions).toContain("theme may be");
  });

  it("reads the widget resource with mcp-app mime type and CSP metadata", async () => {
    const response = await rpc("resources/read", { uri: "ui://widget/inline-quiz-v15.html" });
    const body = await response.json() as any;
    const content = body.result.contents[0];

    expect(content.uri).toBe("ui://widget/inline-quiz-v15.html");
    expect(content.mimeType).toBe("text/html;profile=mcp-app");
    expect(content.text).toContain("quiz-root");
    expect(content._meta.ui.csp.connectDomains).toEqual([]);
    expect(content._meta.ui.csp.resourceDomains).toEqual([]);
    expect(content._meta["openai/widgetCSP"].connect_domains).toEqual([]);
    expect(content._meta["openai/widgetCSP"].resource_domains).toEqual([]);
    expect(content._meta["openai/widgetDescription"]).toContain("interactive quiz");
  });

  it("rejects unknown widget resource URIs", async () => {
    const response = await rpc("resources/read", { uri: "ui://widget/not-current.html" });
    const body = await response.json() as any;

    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain("Unknown resource");
  });

  it("calls the quiz tool and keeps the answer key in hidden metadata", async () => {
    const response = await rpc("tools/call", {
      name: "render_inline_quiz",
      arguments: {
        title: "Smoke quiz",
        theme: "paper",
        questions: [
          {
            prompt: "Which option is correct?",
            answers: [
              { text: "Right", correct: true },
              { text: "Wrong", correct: false }
            ]
          }
        ]
      }
    });
    const body = await response.json() as any;

    expect(body.result.structuredContent.title).toBe("Smoke quiz");
    expect(body.result.structuredContent.theme).toBe("paper");
    expect(body.result.structuredContent.questions[0].choices).toHaveLength(2);
    expect(body.result._meta.answerKey).toBeDefined();
    expect(body.result._meta.retakeArguments.title).toBe("Smoke quiz");
    expect(body.result._meta.retakeArguments.theme).toBe("paper");
    expect(body.result._meta.retakeArguments.questions[0].q).toBe("Which option is correct?");
    expect(body.result._meta.retakeArguments.questions[0].a).toEqual([
      { t: "Right", c: true },
      { t: "Wrong" }
    ]);
    expect(JSON.stringify(body.result.structuredContent)).not.toContain("answerKey");
    for (const choice of body.result.structuredContent.questions[0].choices) {
      expect(choice).not.toHaveProperty("correct");
    }
  });

  it("accepts compact quiz input aliases and omitted false flags", async () => {
    const response = await rpc("tools/call", {
      name: "render_inline_quiz",
      arguments: {
        title: "Compact quiz",
        questions: [
          {
            q: "Which number is prime?",
            type: "mc",
            a: [
              { t: "2", c: true, e: "2 has exactly two positive factors." },
              { t: "4" }
            ]
          }
        ]
      }
    });
    const body = await response.json() as any;

    expect(body.result.structuredContent.title).toBe("Compact quiz");
    expect(body.result.structuredContent.questions[0].prompt).toBe("Which number is prime?");
    expect(body.result.structuredContent.questions[0].choices.map((choice: any) => choice.text).sort()).toEqual(["2", "4"]);
    expect(body.result._meta.answerKey).toBeDefined();
  });

  it("accepts compact matching and sorting questions", async () => {
    const response = await rpc("tools/call", {
      name: "render_inline_quiz",
      arguments: {
        title: "Drag formats",
        shuffleQuestions: false,
        questions: [
          {
            q: "Match each country to its capital.",
            type: "match",
            p: [
              { t: "France", m: "Paris" },
              { t: "Italy", m: "Rome" }
            ]
          },
          {
            q: "Sort the workflow.",
            type: "sort",
            i: [
              { t: "Plan" },
              { t: "Build" },
              { t: "Ship" }
            ]
          }
        ]
      }
    });
    const body = await response.json() as any;
    const [matching, sorting] = body.result.structuredContent.questions;

    expect(matching.type).toBe("matching");
    expect(matching.targets).toHaveLength(2);
    expect(sorting.type).toBe("sorting");
    expect(body.result._meta.answerKey[matching.id].type).toBe("matching");
    expect(body.result._meta.answerKey[sorting.id].type).toBe("sorting");
    expect(body.result._meta.retakeArguments.questions[0].type).toBe("match");
    expect(body.result._meta.retakeArguments.questions[1].type).toBe("sort");
    expect(JSON.stringify(body.result.structuredContent)).not.toContain("answerKey");
  });

  it("allows separate quiz calls without merging or dropping the second result", async () => {
    const response = await handleRequest(
      new Request("https://quiz.example.com/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify([
          {
            jsonrpc: "2.0",
            id: "first",
            method: "tools/call",
            params: { name: "render_inline_quiz", arguments: quizArgs("First quiz") }
          },
          {
            jsonrpc: "2.0",
            id: "second",
            method: "tools/call",
            params: { name: "render_inline_quiz", arguments: quizArgs("Second quiz") }
          }
        ])
      }),
      { WIDGET_DOMAIN: "https://quiz.example.com" }
    );
    const body = await response.json() as any;

    expect(body).toHaveLength(2);
    expect(body[0].id).toBe("first");
    expect(body[1].id).toBe("second");
    expect(body[0].result.structuredContent.title).toBe("First quiz");
    expect(body[1].result.structuredContent.title).toBe("Second quiz");
    expect(body[0].result.structuredContent.quizId).not.toBe(body[1].result.structuredContent.quizId);
    expect(body[1].result._meta.retakeArguments.title).toBe("Second quiz");
  });

  it("rejects oversized requests before parsing JSON", async () => {
    const response = await handleRequest(
      new Request("https://quiz.example.com/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "x".repeat(1_250_001)
      }),
      { WIDGET_DOMAIN: "https://quiz.example.com" }
    );
    const body = await response.json() as any;

    expect(response.status).toBe(413);
    expect(body.error.message).toContain("bytes or less");
  });

  it("rejects non-json MCP requests before parsing the body", async () => {
    const response = await handleRequest(
      new Request("https://quiz.example.com/mcp", {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: "{}"
      }),
      { WIDGET_DOMAIN: "https://quiz.example.com" }
    );
    const body = await response.json() as any;

    expect(response.status).toBe(415);
    expect(body.error.message).toContain("application/json");
  });

  it("locks widget routes to GET and HEAD and sends a strict CSP header", async () => {
    const postResponse = await handleRequest(
      new Request("https://quiz.example.com/widget/quiz.html", { method: "POST" }),
      { WIDGET_DOMAIN: "https://quiz.example.com" }
    );
    expect(postResponse.status).toBe(405);
    expect(postResponse.headers.get("allow")).toBe("GET, HEAD, OPTIONS");

    const getResponse = await handleRequest(
      new Request("https://quiz.example.com/widget/quiz.html"),
      { WIDGET_DOMAIN: "https://quiz.example.com" }
    );
    const csp = getResponse.headers.get("content-security-policy") || "";
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("frame-ancestors https://chatgpt.com https://chat.openai.com");
    expect(getResponse.headers.get("cache-control")).toBe("no-store");
  });

  it("does not serve public HTML pages from root or preview routes", async () => {
    for (const path of ["/", "/preview"]) {
      const response = await handleRequest(
        new Request(`https://quiz.example.com${path}`),
        { WIDGET_DOMAIN: "https://quiz.example.com" }
      );
      const body = await response.json() as any;

      expect(response.status).toBe(404);
      expect(body.error).toBe("Not found");
      expect(response.headers.get("content-security-policy")).toBeNull();
    }
  });

  it("advertises OAuth metadata and returns an Apps SDK auth challenge for protected tool calls", async () => {
    const env = oauthEnv();
    const listResponse = await rpc("tools/list", undefined, env);
    const listBody = await listResponse.json() as any;
    const tool = listBody.result.tools[0];

    expect(tool.securitySchemes).toEqual([{ type: "oauth2", scopes: ["quiz:render"] }]);
    expect(tool._meta.securitySchemes).toEqual([{ type: "oauth2", scopes: ["quiz:render"] }]);

    const metadataResponse = await handleRequest(
      new Request("https://quiz.example.com/.well-known/oauth-protected-resource"),
      env
    );
    const metadata = await metadataResponse.json() as any;
    expect(metadata.resource).toBe("https://quiz.example.com");
    expect(metadata.authorization_servers).toEqual(["https://auth.example.com"]);
    expect(metadata.scopes_supported).toEqual(["quiz:render"]);

    const callResponse = await rpc("tools/call", {
      name: "render_inline_quiz",
      arguments: quizArgs("Protected quiz")
    }, env);
    const callBody = await callResponse.json() as any;

    expect(callBody.result.isError).toBe(true);
    expect(callBody.result._meta["mcp/www_authenticate"][0]).toContain("resource_metadata=\"https://quiz.example.com/.well-known/oauth-protected-resource\"");
    expect(callBody.result._meta["mcp/www_authenticate"][0]).toContain("error=\"invalid_token\"");
  });

  it("hides routes behind the generated admin token gate", async () => {
    const env = {
      AUTH_MODE: "admin_token",
      ADMIN_BEARER_TOKEN: "test-secret",
      WIDGET_DOMAIN: "https://quiz.example.com"
    };

    const hiddenResponse = await handleRequest(
      new Request("https://quiz.example.com/healthz"),
      env
    );
    expect(hiddenResponse.status).toBe(404);

    const visibleResponse = await handleRequest(
      new Request("https://quiz.example.com/healthz", {
        headers: { Authorization: "Bearer test-secret" }
      }),
      env
    );
    expect(visibleResponse.status).toBe(200);

    const mcpHiddenResponse = await handleRequest(
      new Request("https://quiz.example.com/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })
      }),
      env
    );
    expect(mcpHiddenResponse.status).toBe(404);

    const mcpVisibleResponse = await handleRequest(
      new Request("https://quiz.example.com/mcp", {
        method: "POST",
        headers: {
          Authorization: "Basic " + btoa("admin:test-secret"),
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })
      }),
      env
    );
    const body = await mcpVisibleResponse.json() as any;
    expect(body.result.tools[0].name).toBe("render_inline_quiz");
  });
});

async function rpc(method: string, params?: unknown, env = { WIDGET_DOMAIN: "https://quiz.example.com" }) {
  return handleRequest(
    new Request("https://quiz.example.com/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method,
        params
      })
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

function quizArgs(title: string) {
  return {
    title,
    targetGradePercent: 80,
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
