import { describe, expect, it, vi } from "vitest";
import {
  buildQuiz,
  MAX_TITLE_LENGTH,
  normalizeQuizInput,
  QuizInputError,
  secureRandomInt
} from "../src/quiz";

const validQuestion = {
  prompt: "Pick one.",
  answers: [
    { text: "A", correct: true },
    { text: "B", correct: false }
  ]
};

function validQuiz(extra: Record<string, unknown> = {}) {
  return {
    questions: [validQuestion],
    ...extra
  };
}

describe("quiz input security", () => {
  it("rejects accessor properties without invoking hostile getters", () => {
    let getterCalled = false;
    const input = Object.defineProperty({}, "questions", {
      enumerable: true,
      get() {
        getterCalled = true;
        return [validQuestion];
      }
    });

    expect(() => normalizeQuizInput(input)).toThrow("questions must be a data property.");
    expect(getterCalled).toBe(false);
  });

  it("rejects inherited quiz properties", () => {
    const input = Object.create({ questions: [validQuestion] }) as Record<string, unknown>;

    expect(() => normalizeQuizInput(input)).toThrow(QuizInputError);
  });

  it("rejects sparse question and answer arrays", () => {
    const sparseQuestions = new Array(1);
    expect(() => normalizeQuizInput({ questions: sparseQuestions })).toThrow("questions[0] must be provided.");

    const sparseAnswers = new Array(2);
    sparseAnswers[0] = { text: "A", correct: true };
    expect(() =>
      normalizeQuizInput({
        questions: [
          {
            prompt: "Pick one.",
            answers: sparseAnswers
          }
        ]
      })
    ).toThrow("questions[0].answers[1] must be provided.");
  });

  it("rejects accessor array entries without invoking them", () => {
    let getterCalled = false;
    const answers = [
      { text: "A", correct: true },
      { text: "B", correct: false }
    ];
    Object.defineProperty(answers, "1", {
      enumerable: true,
      get() {
        getterCalled = true;
        return { text: "B", correct: false };
      }
    });

    expect(() =>
      normalizeQuizInput({
        questions: [
          {
            prompt: "Pick one.",
            answers
          }
        ]
      })
    ).toThrow("questions[0].answers[1] must be a data property.");
    expect(getterCalled).toBe(false);
  });

  it("bounds raw strings before cleanup while still accepting normalized Unicode text", () => {
    expect(() =>
      normalizeQuizInput(
        validQuiz({
          title: "\u0001".repeat(MAX_TITLE_LENGTH * 4 + 1) + "A"
        })
      )
    ).toThrow("title is too large before cleanup.");

    const decomposedTitle = "e\u0301".repeat(MAX_TITLE_LENGTH);
    expect(normalizeQuizInput(validQuiz({ title: decomposedTitle })).title).toBe(
      "\u00e9".repeat(MAX_TITLE_LENGTH)
    );
  });

  it("removes C0 and C1 controls from quiz text", () => {
    const normalized = normalizeQuizInput({
      questions: [
        {
          prompt: "Alpha\u0000 \u0085Beta\u009f\nGamma",
          answers: [
            { text: "Correct\u0081", correct: true },
            { text: "Wrong", correct: false }
          ]
        }
      ]
    });

    expect(normalized.questions[0]?.prompt).toBe("Alpha Beta Gamma");
    expect(normalized.questions[0]?.answers[0]?.text).toBe("Correct");
  });

  it("rejects schema-mismatched target and shuffle values", () => {
    expect(() => normalizeQuizInput(validQuiz({ targetGradePercent: null }))).toThrow("targetGradePercent");
    expect(() => normalizeQuizInput(validQuiz({ shuffleQuestions: "false" }))).toThrow("shuffleQuestions");
  });

  it("rejects out-of-range custom RNG results before randomizing quiz data", () => {
    expect(() =>
      buildQuiz(validQuiz(), {
        rng: () => 36,
        now: "2026-06-11T00:00:00.000Z"
      })
    ).toThrow("Random integer generator returned an out-of-range value.");
  });
});

describe("secure random integer generation", () => {
  it("accepts the full uint32 range when unbiased for the requested bound", () => {
    const originalGetRandomValues = crypto.getRandomValues.bind(crypto);
    const getRandomValues = vi.fn((array: Uint32Array) => {
      array[0] = 0xffffffff;
      return array;
    });
    Object.defineProperty(crypto, "getRandomValues", {
      configurable: true,
      value: getRandomValues
    });

    try {
      expect(secureRandomInt(2)).toBe(1);
      expect(getRandomValues).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(crypto, "getRandomValues", {
        configurable: true,
        value: originalGetRandomValues
      });
    }
  });

  it("rejects impossible uint32 bounds instead of looping forever", () => {
    expect(() => secureRandomInt(0x100000001)).toThrow("at most 4294967296");
  });
});
