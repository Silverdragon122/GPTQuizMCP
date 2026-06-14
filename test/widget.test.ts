import { describe, expect, it } from "vitest";
import { QUIZ_WIDGET_HTML } from "../src/widget";

class TestTextNode {
  constructor(public textContent: string) {}
}

type TestChild = TestElement | TestTextNode;

class TestElement {
  children: TestChild[] = [];
  className = "";
  disabled = false;
  id = "";
  tabIndex = 0;
  title = "";
  type = "";
  private attributes: Record<string, string> = {};
  private ownText = "";
  private listeners: Record<string, Array<() => void>> = {};
  readonly style = {
    setProperty: (_name: string, _value: string) => undefined,
    removeProperty: (_name: string) => undefined
  };
  readonly classList = {
    contains: (name: string) => this.className.split(/\s+/).includes(name),
    add: (name: string) => {
      if (!this.classList.contains(name)) {
        this.className = [this.className, name].filter(Boolean).join(" ");
      }
    },
    remove: (name: string) => {
      this.className = this.className
        .split(/\s+/)
        .filter((item) => item && item !== name)
        .join(" ");
    }
  };

  constructor(readonly tagName: string) {}

  get textContent(): string {
    return this.ownText + this.children.map((child) => child.textContent).join("");
  }

  set textContent(value: string) {
    this.children = [];
    this.ownText = String(value ?? "");
  }

  append(...items: Array<TestChild | string>): void {
    this.children.push(...items.map((item) => typeof item === "string" ? new TestTextNode(item) : item));
  }

  replaceChildren(...items: Array<TestChild | string>): void {
    this.children = [];
    this.ownText = "";
    this.append(...items);
  }

  setAttribute(name: string, value: string): void {
    this.attributes[name] = String(value);
    if (name === "id") {
      this.id = String(value);
    }
  }

  getAttribute(name: string): string | undefined {
    return this.attributes[name];
  }

  addEventListener(type: string, handler: unknown): void {
    if (typeof handler !== "function") {
      return;
    }
    this.listeners[type] = this.listeners[type] ?? [];
    this.listeners[type]!.push(handler as () => void);
  }

  click(): void {
    for (const handler of this.listeners.click ?? []) {
      handler();
    }
  }

  getBoundingClientRect() {
    return { height: 420 };
  }
}

class TestStorage {
  values: Record<string, string> = {};

  constructor(private readonly options: { failGet?: boolean; failSet?: boolean } = {}) {}

  getItem(key: string): string | null {
    if (this.options.failGet) {
      throw new Error("Storage get failed");
    }
    return this.values[key] ?? null;
  }

  setItem(key: string, value: string): void {
    if (this.options.failSet) {
      throw new Error("Storage set failed");
    }
    this.values[key] = String(value);
  }

  removeItem(key: string): void {
    delete this.values[key];
  }
}

describe("quiz widget hydration", () => {
  it("embeds a pinned local KaTeX runtime without remote resources", () => {
    expect(QUIZ_WIDGET_HTML.startsWith("<!doctype html>")).toBe(true);
    expect(QUIZ_WIDGET_HTML).toContain('data-quiz-vendor="katex"');
    expect(QUIZ_WIDGET_HTML).toContain('data-version="0.17.0"');
    expect(QUIZ_WIDGET_HTML).toContain("renderToString");
    expect(QUIZ_WIDGET_HTML).not.toContain("cdn.jsdelivr");
    expect(QUIZ_WIDGET_HTML).not.toContain("unpkg.com");
  });

  it("uses transform-based progress and loading motion without a visible reset", () => {
    const style = extractWidgetStyle();
    const progressRule = extractCssRule(style, ".progress-fill");
    const loadingRule = extractCssRule(style, ".loading-bar::before");

    expect(progressRule).toContain("width: 100%;");
    expect(progressRule).toContain("transform: scaleX(var(--progress-scale, 0));");
    expect(progressRule).toContain("transition: transform 220ms");
    expect(progressRule).not.toContain("width 220ms");
    expect(loadingRule).toContain("width: 46%;");
    expect(loadingRule).toContain("transform: translateX(-125%);");
    expect(style).toContain("transform: translateX(320%);");
    expect(style).not.toContain("background-position:");
    expect(QUIZ_WIDGET_HTML).toContain('setProperty("--progress-scale"');
  });

  it("hydrates from mcp_tool_result metadata when toolOutput is empty", () => {
    const toolResult = makeToolResult("Metadata quiz", "quiz_metadata");
    const { openai, root } = mountWidget({
      toolOutput: null,
      toolResponseMetadata: {
        status: "completed",
        mcp_tool_result: toolResult
      }
    });

    expect(openai.widgetState).toBeNull();
    expect(root.textContent).toContain("Metadata quiz");
    expect(root.textContent).not.toContain("Waiting for quiz data");
  });

  it("hydrates from nested call_tool_result result metadata", () => {
    const toolResult = makeToolResult("Nested metadata quiz", "quiz_nested");
    const { openai, root } = mountWidget({
      toolOutput: null,
      toolResponseMetadata: {
        status: "completed",
        call_tool_result: {
          result: toolResult
        }
      }
    });

    expect(openai.widgetState).toBeNull();
    expect(root.textContent).toContain("Nested metadata quiz");
    expect(root.textContent).not.toContain("Waiting for quiz data");
  });

  it("hydrates from late MCP bridge tool-result notifications", () => {
    const toolResult = makeToolResult("Late bridge quiz", "quiz_late_bridge");
    const { openai, root, dispatchWindowEvent, windowShim } = mountWidget({
      toolOutput: null,
      toolResponseMetadata: {}
    });

    expect(root.textContent).toContain("Waiting for quiz data");

    dispatchWindowEvent("message", {
      source: windowShim.parent,
      data: {
        jsonrpc: "2.0",
        method: "ui/notifications/tool-result",
        params: toolResult
      }
    });

    expect(openai.widgetState).toBeNull();
    expect(root.textContent).toContain("Late bridge quiz");
    expect(root.textContent).not.toContain("Waiting for quiz data");
  });

  it("hydrates from late ChatGPT global updates after long tool calls", () => {
    const toolResult = makeToolResult("Late globals quiz", "quiz_late_globals");
    const { openai, root, dispatchWindowEvent } = mountWidget({
      toolOutput: null,
      toolResponseMetadata: {}
    });

    expect(root.textContent).toContain("Waiting for quiz data");

    dispatchWindowEvent("openai:set_globals", {
      detail: {
        globals: {
          toolInput: toolResult._meta.retakeArguments,
          toolOutput: toolResult.structuredContent,
          toolResponseMetadata: { _meta: toolResult._meta }
        }
      }
    });

    expect(openai.widgetState).toBeNull();
    expect(root.textContent).toContain("Late globals quiz");
    expect(root.textContent).not.toContain("Waiting for quiz data");
  });

  it("does not call host widget-state persistence when explicitly disabled", () => {
    const toolResult = makeToolResult("No host persistence quiz", "quiz_no_host_persist");
    const { openai, root } = mountWidget(
      {
        toolOutput: toolResult.structuredContent,
        toolResponseMetadata: { _meta: toolResult._meta }
      },
      { persistWidgetState: false }
    );

    expect(root.textContent).toContain("No host persistence quiz");
    expect(openai.widgetState).toBeNull();

    findButtonContainingText(root, "Correct")!.click();
    expect(root.textContent).toContain("Correct");
    expect(openai.widgetState).toBeNull();
  });

  it("uses host widget-state persistence when the bridge is available", () => {
    const storage = new TestStorage();
    const toolResult = makeToolResult("Default host persistence quiz", "quiz_default_host_persist");
    const { openai, root } = mountWidget(
      {
        toolOutput: toolResult.structuredContent,
        toolResponseMetadata: { _meta: toolResult._meta }
      },
      { localStorage: storage, persistWidgetState: "unset" }
    );

    findButtonContainingText(root, "Correct")!.click();

    expect(openai.widgetState).toMatchObject({
      privateContent: {
        quizId: "quiz_default_host_persist",
        answers: {
          q_0: "a_0_0"
        }
      }
    });
    expect(storage.getItem("quiz-mcp-progress:quiz_default_host_persist")).toContain('"answers"');
  });

  it("restores compact progress from local fallback storage", () => {
    const storage = new TestStorage();
    storage.setItem("quiz-mcp-progress:quiz_local_fallback", JSON.stringify({
      version: 5,
      quizId: "quiz_local_fallback",
      updatedAt: 10,
      answers: { q_0: "a_0_1" },
      phase: "feedback"
    }));
    const toolResult = makeToolResult("Local fallback quiz", "quiz_local_fallback");
    const { root } = mountWidget(
      {
        toolOutput: toolResult.structuredContent,
        toolResponseMetadata: { _meta: toolResult._meta },
        widgetState: null
      },
      { localStorage: storage }
    );

    expect(root.textContent).toContain("Local fallback quiz");
    expect(root.textContent).toContain("Not quite");
  });

  it("restores compact progress from cookies when localStorage is unavailable", () => {
    const storage = new TestStorage({ failGet: true, failSet: true });
    const encodedProgress = encodeURIComponent(JSON.stringify({
      version: 5,
      quizId: "quiz_cookie_fallback",
      updatedAt: 10,
      answers: { q_0: "a_0_1" },
      phase: "feedback"
    }));
    const toolResult = makeToolResult("Cookie fallback quiz", "quiz_cookie_fallback");
    const { root } = mountWidget(
      {
        toolOutput: toolResult.structuredContent,
        toolResponseMetadata: { _meta: toolResult._meta },
        widgetState: null
      },
      {
        cookie: `quiz_mcp_progress_quiz_cookie_fallback=${encodedProgress}`,
        localStorage: storage
      }
    );

    expect(root.textContent).toContain("Cookie fallback quiz");
    expect(root.textContent).toContain("Not quite");
  });

  it("requires submit for multi-correct questions and scores the exact selected set", () => {
    const toolResult = makeToolResult("Multi-correct quiz", "quiz_multi", {
      choices: [
        { id: "a_0_0", text: "2" },
        { id: "a_0_1", text: "3" },
        { id: "a_0_2", text: "4" }
      ],
      answerKey: { q_0: ["a_0_0", "a_0_1"] }
    });
    const { openai, root } = mountWidget({
      toolOutput: toolResult.structuredContent,
      toolResponseMetadata: { _meta: toolResult._meta }
    });
    const multiButtons = findElements(root, (element) =>
      element.tagName === "button" && element.className.includes("multi-answer")
    );
    const initialSubmit = findButtonByText(root, "Submit answer");

    expect(multiButtons).toHaveLength(3);
    expect(initialSubmit?.disabled).toBe(true);

    findButtonContainingText(root, "3")!.click();
    expect(openai.widgetState).toMatchObject({
      privateContent: {
        quizId: "quiz_multi",
        selections: {
          q_0: ["a_0_1"]
        }
      }
    });
    expect(findButtonByText(root, "Submit answer")?.disabled).toBe(false);

    findButtonContainingText(root, "2")!.click();
    findButtonByText(root, "Submit answer")!.click();
    expect(openai.widgetState).toMatchObject({
      privateContent: {
        quizId: "quiz_multi",
        answers: {
          q_0: expect.arrayContaining(["a_0_0", "a_0_1"])
        }
      }
    });
  });

  it("marks a multi-correct answer wrong when the submitted set is incomplete", () => {
    const toolResult = makeToolResult("Incomplete multi-correct quiz", "quiz_incomplete", {
      choices: [
        { id: "a_0_0", text: "2" },
        { id: "a_0_1", text: "3" },
        { id: "a_0_2", text: "4" }
      ],
      answerKey: { q_0: ["a_0_0", "a_0_1"] }
    });
    const { openai, root } = mountWidget({
      toolOutput: toolResult.structuredContent,
      toolResponseMetadata: { _meta: toolResult._meta }
    });

    findButtonContainingText(root, "3")!.click();
    findButtonByText(root, "Submit answer")!.click();
    expect(openai.widgetState).toMatchObject({
      privateContent: {
        quizId: "quiz_incomplete",
        answers: {
          q_0: "a_0_1"
        }
      }
    });
  });

  it("lets long prompts and answers expand instead of creating scroll pockets", () => {
    const style = extractWidgetStyle();
    const shellRule = extractCssRule(style, ".quiz-shell.fixed-height");
    const titleRule = extractCssRule(style, ".title");
    const contentRule = extractCssRule(style, ".content");
    const cardRule = extractCssRule(style, ".question-card");
    const promptRule = extractCssRule(style, ".prompt");
    const answersRule = extractCssRule(style, ".answers");
    const longAnswersRule = extractCssRule(style, ".answers.long-answers .answer");
    const answerRule = extractCssRule(style, ".answer");
    const answerTextRule = extractCssRule(style, ".answer-text");
    const feedbackRule = extractCssRule(style, ".feedback");
    const resultRule = extractCssRule(style, ".result");
    const reviewSummaryRule = extractCssRule(style, ".review-summary");
    const primaryActionRule = extractCssRule(style, ".primary-action,\n  .secondary-action,\n  .subtle-action");

    expect(shellRule).toContain("min-height: var(--fixed-shell-height);");
    expect(shellRule).not.toMatch(/\n\s+height:\s*var\(--fixed-shell-height\);/);
    expect(titleRule).toContain("overflow-wrap: anywhere;");
    expect(contentRule).toContain("overflow: visible;");
    expect(contentRule).not.toContain("min-height: var(--question-content-min");
    expect(contentRule).not.toMatch(/\n\s+height:/);
    expect(cardRule).toContain("grid-template-rows: auto auto auto;");
    expect(cardRule).not.toContain("min-height: var(--question-content-min");
    expect(promptRule).toContain("overflow: visible;");
    expect(promptRule).toContain("overflow-wrap: anywhere;");
    expect(promptRule).not.toContain("overflow: auto;");
    expect(promptRule).not.toContain("min-height: var(--prompt-min");
    expect(answersRule).toContain("display: flex;");
    expect(answersRule).toContain("flex-wrap: wrap;");
    expect(answersRule).toContain("align-content: flex-start;");
    expect(answersRule).toContain("align-items: stretch;");
    expect(answersRule).toContain("overflow: visible;");
    expect(answersRule).not.toContain("overflow: auto;");
    expect(answersRule).not.toContain("min-height: var(--answer-grid-min");
    expect(longAnswersRule).toContain("flex-basis: 100%;");
    expect(answerRule).toContain("flex: 0 0 calc((100% - 10px) / 2);");
    expect(answerRule).toContain("min-width: 0;");
    expect(answerRule).toContain("min-height: 54px;");
    expect(answerRule).not.toMatch(/\n\s+height:\s*54px;/);
    expect(answerTextRule).toContain("overflow-wrap: anywhere;");
    expect(answerTextRule).toContain("word-break: break-word;");
    expect(answerTextRule).not.toContain("-webkit-line-clamp");
    expect(feedbackRule).toContain("overflow: visible;");
    expect(resultRule).toContain("overflow: visible;");
    expect(reviewSummaryRule).toContain("overflow: visible;");
    expect(primaryActionRule).toContain("height: auto;");
    expect(style).not.toContain("feedback-placeholder");
    expect(style).not.toContain("-webkit-line-clamp");
  });

  it("applies tool themes and persists user theme changes locally", () => {
    const storage = new TestStorage();
    const toolResult = makeToolResult("Theme quiz", "quiz_theme", { theme: "ember" });
    const { root } = mountWidget(
      {
        toolOutput: toolResult.structuredContent,
        toolResponseMetadata: { _meta: toolResult._meta }
      },
      { localStorage: storage }
    );

    expect(root.getAttribute("data-theme")).toBe("ember");
    expect(storage.getItem("quiz-mcp-theme")).toBe("ember");

    findButtonByText(root, "Theme")!.click();
    expect(root.textContent).toContain("Harbor");

    findButtonByText(root, "Harbor")!.click();
    expect(root.getAttribute("data-theme")).toBe("harbor");
    expect(storage.getItem("quiz-mcp-theme")).toBe("harbor");
    expect(storage.getItem("quiz-mcp-progress:quiz_theme")).toContain('"theme":"harbor"');
  });

  it("restores saved theme before applying the tool-provided theme", () => {
    const storage = new TestStorage();
    storage.setItem("quiz-mcp-theme", "harbor");
    const toolResult = makeToolResult("Saved theme quiz", "quiz_saved_theme", { theme: "ember" });
    const { root } = mountWidget(
      {
        toolOutput: toolResult.structuredContent,
        toolResponseMetadata: { _meta: toolResult._meta }
      },
      { localStorage: storage }
    );

    expect(root.getAttribute("data-theme")).toBe("harbor");
  });

  it("restores per-quiz theme snapshots immediately after a theme-only change", () => {
    const storage = new TestStorage();
    storage.setItem("quiz-mcp-progress:quiz_snapshot_theme", JSON.stringify({
      version: 5,
      quizId: "quiz_snapshot_theme",
      updatedAt: 10,
      theme: "harbor"
    }));
    const toolResult = makeToolResult("Snapshot theme quiz", "quiz_snapshot_theme", { theme: "ember" });
    const { root } = mountWidget(
      {
        toolOutput: toolResult.structuredContent,
        toolResponseMetadata: { _meta: toolResult._meta },
        widgetState: null
      },
      { localStorage: storage }
    );

    expect(root.getAttribute("data-theme")).toBe("harbor");
  });

  it("persists theme to cookies when localStorage quota is exhausted", () => {
    const storage = new TestStorage({ failSet: true });
    const toolResult = makeToolResult("Theme cookie quiz", "quiz_theme_cookie", { theme: "ember" });
    const { cookie, root } = mountWidget(
      {
        toolOutput: toolResult.structuredContent,
        toolResponseMetadata: { _meta: toolResult._meta }
      },
      { localStorage: storage }
    );

    expect(root.getAttribute("data-theme")).toBe("ember");

    findButtonByText(root, "Theme")!.click();
    findButtonByText(root, "Harbor")!.click();

    expect(root.getAttribute("data-theme")).toBe("harbor");
    expect(cookie()).toContain("quiz_mcp_theme=harbor");
  });

  it("keeps learn and review off the mid-quiz toolbar and opens learn from results", () => {
    const toolResult = makeToolResult("Study modes quiz", "quiz_study_modes");
    const { openai, root } = mountWidget({
      toolOutput: toolResult.structuredContent,
      toolResponseMetadata: { _meta: toolResult._meta }
    });

    expect(findButtonByText(root, "Learn")).toBeUndefined();
    expect(findButtonByText(root, "Review")).toBeUndefined();

    findButtonContainingText(root, "Correct")!.click();
    findButtonByText(root, "Show score")!.click();
    findButtonByText(root, "Learn")!.click();
    expect(openai.widgetState).toMatchObject({
      privateContent: {
        studyMode: "learn",
        review: true
      }
    });
    expect(root.textContent).toContain("Learning from answered questions.");
    expect(root.textContent).toContain("Correct answer:");
    expect(openai.widgetState).toMatchObject({
      privateContent: {
        revealed: {
          q_0: true
        }
      }
    });
    expect(storageSnapshot(openai.widgetState)).toMatchObject({
      studyMode: "learn",
      review: true,
      phase: "review"
    });

    findButtonByText(root, "Flag")!.click();
    expect(openai.widgetState).toMatchObject({
      privateContent: {
        flagged: {
          q_0: true
        }
      }
    });
  });

  it("persists learn mode to local fallback storage", () => {
    const storage = new TestStorage();
    const toolResult = makeToolResult("Learn memory quiz", "quiz_learn_memory");
    const { root } = mountWidget(
      {
        toolOutput: toolResult.structuredContent,
        toolResponseMetadata: { _meta: toolResult._meta }
      },
      { localStorage: storage }
    );

    findButtonContainingText(root, "Correct")!.click();
    findButtonByText(root, "Show score")!.click();
    findButtonByText(root, "Learn")!.click();

    expect(JSON.parse(storage.getItem("quiz-mcp-progress:quiz_learn_memory") || "{}")).toMatchObject({
      quizId: "quiz_learn_memory",
      review: true,
      studyMode: "learn",
      phase: "review"
    });
  });

  it("clears saved result state before starting another quiz", () => {
    const messages: any[] = [];
    const storage = new TestStorage();
    const toolResult = makeToolResult("New quiz memory", "quiz_new_memory");
    const { openai, root } = mountWidget(
      {
        toolOutput: toolResult.structuredContent,
        toolResponseMetadata: { _meta: toolResult._meta },
        sendFollowUpMessage(message: unknown) {
          messages.push(message);
        }
      },
      { localStorage: storage }
    );

    findButtonContainingText(root, "Correct")!.click();
    findButtonByText(root, "Show score")!.click();
    findButtonByText(root, "New quiz")!.click();

    expect(messages).toHaveLength(1);
    expect(storageSnapshot(openai.widgetState)).toMatchObject({
      quizId: "quiz_new_memory",
      cleared: true
    });
    expect(JSON.parse(storage.getItem("quiz-mcp-progress:quiz_new_memory") || "{}")).toMatchObject({
      quizId: "quiz_new_memory",
      cleared: true
    });
  });

  it("clears saved result state before redoing a quiz through the tool bridge", () => {
    const storage = new TestStorage();
    const toolResult = makeToolResult("Redo memory", "quiz_redo_memory");
    let callCount = 0;
    const { openai, root } = mountWidget(
      {
        toolOutput: toolResult.structuredContent,
        toolResponseMetadata: { _meta: toolResult._meta },
        async callTool() {
          callCount += 1;
          return makeToolResult("Redo memory", "quiz_redo_memory_next");
        }
      },
      { localStorage: storage }
    );

    findButtonContainingText(root, "Correct")!.click();
    findButtonByText(root, "Show score")!.click();
    findButtonByText(root, "Try again")!.click();

    expect(callCount).toBe(1);
    expect(storageSnapshot(openai.widgetState)).toMatchObject({
      quizId: "quiz_redo_memory",
      cleared: true
    });
    expect(JSON.parse(storage.getItem("quiz-mcp-progress:quiz_redo_memory") || "{}")).toMatchObject({
      quizId: "quiz_redo_memory",
      cleared: true
    });
  });

  it("routes missed-only review through the active review filter", () => {
    const toolResult = makeToolResult("Review quiz", "quiz_review");
    const { openai, root } = mountWidget({
      toolOutput: toolResult.structuredContent,
      toolResponseMetadata: { _meta: toolResult._meta }
    });

    findButtonContainingText(root, "Incorrect")!.click();
    findButtonByText(root, "Show score")!.click();
    findButtonByText(root, "Missed only")!.click();

    expect(openai.widgetState).toMatchObject({
      privateContent: {
        review: true,
        reviewMode: "missed",
        studyMode: "review"
      }
    });
    expect(root.textContent).toContain("Reviewing missed answers.");
  });

  it("asks ChatGPT to use standard LaTeX for answered-question explanations", () => {
    const messages: any[] = [];
    const toolResult = makeToolResult("LaTeX explain quiz", "quiz_latex_explain");
    const { root } = mountWidget({
      toolOutput: toolResult.structuredContent,
      toolResponseMetadata: { _meta: toolResult._meta },
      sendFollowUpMessage(message: unknown) {
        messages.push(message);
      }
    });

    findButtonContainingText(root, "Correct")!.click();
    findButtonByText(root, "Explain this")!.click();

    expect(messages).toHaveLength(1);
    expect(messages[0].prompt).toContain("standard LaTeX notation");
    expect(messages[0].prompt).toContain("$...$");
    expect(messages[0].prompt).toContain("$$...$$");
  });

  it("asks ChatGPT to use standard LaTeX for result reviews", () => {
    const messages: any[] = [];
    const toolResult = makeToolResult("LaTeX review quiz", "quiz_latex_review");
    const { root } = mountWidget({
      toolOutput: toolResult.structuredContent,
      toolResponseMetadata: { _meta: toolResult._meta },
      sendFollowUpMessage(message: unknown) {
        messages.push(message);
      }
    });

    findButtonContainingText(root, "Correct")!.click();
    findButtonByText(root, "Show score")!.click();
    findButtonByText(root, "Review with GPT")!.click();

    expect(messages).toHaveLength(1);
    expect(messages[0].prompt).toContain("standard LaTeX notation");
    expect(messages[0].prompt).toContain("$...$");
    expect(messages[0].prompt).toContain("$$...$$");
  });

  it("asks ChatGPT to use standard LaTeX for study-mode explanations", () => {
    const messages: any[] = [];
    const toolResult = makeToolResult("LaTeX study quiz", "quiz_latex_study");
    const { root } = mountWidget({
      toolOutput: toolResult.structuredContent,
      toolResponseMetadata: { _meta: toolResult._meta },
      sendFollowUpMessage(message: unknown) {
        messages.push(message);
      }
    });

    findButtonContainingText(root, "Correct")!.click();
    findButtonByText(root, "Show score")!.click();
    findButtonByText(root, "Learn")!.click();
    findButtonByText(root, "Explain this")!.click();

    expect(messages).toHaveLength(1);
    expect(messages[0].prompt).toContain("standard LaTeX notation");
    expect(messages[0].prompt).toContain("$...$");
    expect(messages[0].prompt).toContain("$$...$$");
  });

  it("uses full-width compact answer layout for very long choices", () => {
    const longChoice =
      "Swahili Coast culture, Islamization in conquered regions, Columbian Exchange foodways, and Renaissance blending of classical and Christian ideas.";
    const toolResult = makeToolResult("Long answer quiz", "quiz_long_answers", {
      choices: [
        { id: "a_0_0", text: longChoice },
        { id: "a_0_1", text: "Legalism, feudalism, absolutism, and civil service exams." },
        { id: "a_0_2", text: "Supply and demand, inflation, mercantilism, and royal charters." },
        { id: "a_0_3", text: "Great Wall, Versailles, Kaaba, and Magna Carta." }
      ],
      answerKey: { q_0: "a_0_0" }
    });
    const { root } = mountWidget({
      toolOutput: toolResult.structuredContent,
      toolResponseMetadata: { _meta: toolResult._meta }
    });

    expect(findElements(root, (element) => element.className === "answers long-answers")).toHaveLength(1);
    expect(findButtonContainingText(root, "Swahili Coast")?.className).toContain("compact-answer");
  });
});

function mountWidget(
  openai: Record<string, unknown>,
  options: { cookie?: string; localStorage?: TestStorage; persistWidgetState?: boolean | "unset" } = {}
) {
  const root = new TestElement("div");
  const windowListeners: Record<string, Array<(event: any) => void>> = {};
  const cookies = new Map<string, string>();
  for (const part of (options.cookie || "").split(/;\s*/)) {
    const index = part.indexOf("=");
    if (index > 0) {
      cookies.set(part.slice(0, index), part.slice(index + 1));
    }
  }
  const documentShim = {
    visibilityState: "visible",
    getElementById: (id: string) => id === "quiz-root" ? root : null,
    createElement: (tagName: string) => new TestElement(tagName),
    createTextNode: (text: string) => new TestTextNode(text),
    addEventListener: (_type: string, _handler: unknown) => undefined,
    get cookie() {
      return [...cookies.entries()].map(([key, value]) => `${key}=${value}`).join("; ");
    },
    set cookie(value: string) {
      const [pair, ...attributes] = String(value || "").split(";");
      const index = pair.indexOf("=");
      if (index < 1) {
        return;
      }
      const key = pair.slice(0, index);
      const cookieValue = pair.slice(index + 1);
      if (attributes.some((attribute) => attribute.trim().toLowerCase() === "max-age=0")) {
        cookies.delete(key);
      } else {
        cookies.set(key, cookieValue);
      }
    }
  };
  const openaiShim: Record<string, unknown> = {
    widgetState: null,
    notifyIntrinsicHeight() {},
    sendFollowUpMessage(_message: unknown) {},
    ...openai
  };
  openaiShim.setWidgetState = (state: unknown) => {
    openaiShim.widgetState = state;
  };
  const windowShim: Record<string, unknown> = {
    openai: openaiShim,
    parent: {},
    __QUIZ_PREVIEW__: null,
    __QUIZ_PREVIEW_META__: {},
    localStorage: options.localStorage,
    addEventListener: (type: string, handler: unknown) => {
      if (typeof handler !== "function") {
        return;
      }
      windowListeners[type] = windowListeners[type] ?? [];
      windowListeners[type]!.push(handler as (event: any) => void);
    }
  };
  if (options.persistWidgetState !== "unset") {
    windowShim.__QUIZ_DISABLE_WIDGET_STATE__ = options.persistWidgetState === false;
  }
  windowShim.parent = windowShim;

  const runWidget = new Function(
    "window",
    "document",
    "setTimeout",
    "clearTimeout",
    "console",
    extractWidgetScript()
  );
  runWidget(
    windowShim,
    documentShim,
    () => 1,
    () => undefined,
    { error: () => undefined, warn: () => undefined }
  );

  return {
    root,
    cookie: () => documentShim.cookie,
    openai: windowShim.openai as Record<string, unknown>,
    windowShim,
    dispatchWindowEvent(type: string, event: any) {
      for (const handler of windowListeners[type] ?? []) {
        handler(event);
      }
    }
  };
}

function extractWidgetScript(): string {
  const match = QUIZ_WIDGET_HTML.match(/<script type="module">([\s\S]*)<\/script>/);
  if (!match?.[1]) {
    throw new Error("Widget script was not found.");
  }

  return match[1];
}

function storageSnapshot(widgetState: unknown): any {
  return (widgetState as any)?.privateContent ?? widgetState;
}

function extractWidgetStyle(): string {
  const match = QUIZ_WIDGET_HTML.match(/<style>([\s\S]*)<\/style>/);
  if (!match?.[1]) {
    throw new Error("Widget style was not found.");
  }

  return match[1];
}

function extractCssRule(style: string, selector: string): string {
  const match = style.match(new RegExp("(?:^|\\n)  " + escapeRegExp(selector) + "\\s*\\{([\\s\\S]*?)\\n  \\}"));
  if (!match?.[1]) {
    throw new Error("CSS rule was not found: " + selector);
  }

  return match[1];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findElements(root: TestElement, predicate: (element: TestElement) => boolean): TestElement[] {
  const matches: TestElement[] = [];
  const visit = (node: TestChild) => {
    if (node instanceof TestTextNode) {
      return;
    }
    if (predicate(node)) {
      matches.push(node);
    }
    for (const child of node.children) {
      visit(child);
    }
  };
  visit(root);
  return matches;
}

function findButtonByText(root: TestElement, text: string): TestElement | undefined {
  return findElements(root, (element) =>
    element.tagName === "button" && element.textContent === text
  )[0];
}

function findButtonContainingText(root: TestElement, text: string): TestElement | undefined {
  return findElements(root, (element) =>
    element.tagName === "button" && element.textContent.includes(text)
  )[0];
}

function makeToolResult(
  title: string,
  quizId: string,
  options: {
    choices?: Array<{ id: string; text: string }>;
    answerKey?: Record<string, string | string[]>;
    theme?: string;
  } = {}
) {
  const choices = options.choices ?? [
    { id: "a_0_0", text: "Correct" },
    { id: "a_0_1", text: "Incorrect" }
  ];
  const answerKey = options.answerKey ?? { q_0: "a_0_0" };

  return {
    structuredContent: {
      quizId,
      title,
      totalQuestions: 1,
      targetGradePercent: 100,
      passingScorePercent: 100,
      ...(options.theme ? { theme: options.theme } : {}),
      questions: [
        {
          id: "q_0",
          prompt: "Pick the correct answer.",
          type: "multiple_choice",
          choices
        }
      ]
    },
    _meta: {
      answerKey,
      explanations: { q_0: "Correct is the marked answer." },
      choiceExplanations: {},
      generatedAt: "2026-06-11T00:00:00.000Z",
      shuffle: {
        questions: false,
        answers: true
      },
      retakeArguments: {
        title,
        questions: [
          {
            prompt: "Pick the correct answer.",
            answers: [
              { text: "Correct", correct: true },
              { text: "Incorrect", correct: false }
            ]
          }
        ]
      }
    }
  };
}
