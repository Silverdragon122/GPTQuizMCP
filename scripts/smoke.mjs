const endpoint = process.env.MCP_URL || "http://127.0.0.1:8787/mcp";

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

const calls = [
  ["initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "smoke", version: "1.0.0" } }],
  ["tools/list", {}],
  ["resources/read", { uri: "ui://widget/inline-quiz-v3.html" }],
  ["tools/call", { name: "render_inline_quiz", arguments: sampleQuiz }]
];

for (let index = 0; index < calls.length; index += 1) {
  const [method, params] = calls[index];
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: index + 1, method, params })
  });

  if (!response.ok) {
    throw new Error(`${method} failed with HTTP ${response.status}: ${await response.text()}`);
  }

  const body = await response.json();
  if (body.error || body.result?.isError) {
    throw new Error(`${method} returned an error: ${JSON.stringify(body)}`);
  }

  console.log(`${method}: ok`);
}
