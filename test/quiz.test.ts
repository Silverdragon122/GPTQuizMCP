import { describe, expect, it } from "vitest";
import { buildQuiz, normalizeQuizInput, QuizInputError, type RandomInt } from "../src/quiz";

const sampleQuiz = {
  title: "Cloud basics",
  questions: [
    {
      prompt: "Workers run closest to which infrastructure layer?",
      answers: [
        { text: "Edge network", correct: true, explanation: "Workers execute on Cloudflare's edge network." },
        { text: "A single VM", correct: false },
        { text: "A desktop browser", correct: false }
      ]
    },
    {
      prompt: "A true/false quiz can use two choices.",
      type: "true_false",
      answers: [
        { text: "True", correct: true },
        { text: "False", correct: false }
      ]
    }
  ]
};

describe("quiz builder", () => {
  it("returns shuffled quiz data without leaking correct flags in structured content", () => {
    const quiz = buildQuiz(sampleQuiz, { rng: cyclingRng(), now: "2026-06-11T00:00:00.000Z" });

    expect(quiz.structuredContent.title).toBe("Cloud basics");
    expect(quiz.structuredContent.questions).toHaveLength(2);
    expect(Object.keys(quiz.meta.answerKey)).toHaveLength(2);
    expect(JSON.stringify(quiz.structuredContent)).not.toContain("answerKey");
    expect(Object.keys(quiz.meta.choiceExplanations)).toHaveLength(1);
    expect(JSON.stringify(quiz.structuredContent)).not.toContain("choiceExplanations");

    for (const question of quiz.structuredContent.questions) {
      for (const choice of question.choices) {
        expect(choice).not.toHaveProperty("correct");
      }
      expect(question.choices.some((choice) => choice.id === quiz.meta.answerKey[question.id])).toBe(true);
    }
  });

  it("infers true_false for True and False answers", () => {
    const normalized = normalizeQuizInput({
      questions: [
        {
          prompt: "The sky is blue on a clear day.",
          answers: [
            { text: "True", correct: true },
            { text: "False", correct: false }
          ]
        }
      ]
    });

    expect(normalized.questions[0]?.type).toBe("true_false");
  });

  it("accepts larger single-call quizzes and target grades", () => {
    const quiz = buildQuiz(
      {
        title: "Fifty item set",
        targetGradePercent: 85,
        questions: Array.from({ length: 50 }, (_, index) => ({
          prompt: `Question ${index + 1}`,
          answers: [
            { text: "Correct", correct: true },
            { text: "Distractor", correct: false }
          ]
        }))
      },
      { rng: cyclingRng(), now: "2026-06-11T00:00:00.000Z" }
    );

    expect(quiz.structuredContent.totalQuestions).toBe(50);
    expect(quiz.structuredContent.targetGradePercent).toBe(85);
    expect(quiz.structuredContent.passingScorePercent).toBe(85);
    expect(quiz.retakeInput.targetGradePercent).toBe(85);
    expect(quiz.retakeInput.questions).toHaveLength(50);
  });

  it("accepts compact aliases and omitted false answer flags", () => {
    const normalized = normalizeQuizInput({
      questions: [
        {
          q: "Which number is prime?",
          type: "mc",
          e: "A prime has exactly two positive factors.",
          a: [
            { t: "2", c: true, e: "2 is prime." },
            { t: "4" }
          ]
        },
        {
          q: "The sky is blue on a clear day.",
          type: "tf",
          a: [
            { t: "True", c: true },
            { t: "False" }
          ]
        }
      ]
    });

    expect(normalized.questions[0]?.prompt).toBe("Which number is prime?");
    expect(normalized.questions[0]?.type).toBe("multiple_choice");
    expect(normalized.questions[0]?.explanation).toBe("A prime has exactly two positive factors.");
    expect(normalized.questions[0]?.answers[0]).toMatchObject({ text: "2", correct: true });
    expect(normalized.questions[0]?.answers[1]).toMatchObject({ text: "4", correct: false });
    expect(normalized.questions[1]?.type).toBe("true_false");
    expect(normalized.retakeInput.questions[0]?.answers[1]?.correct).toBe(false);
  });

  it("keeps backward-compatible passing score as a target-grade alias", () => {
    const normalized = normalizeQuizInput({
      passingScorePercent: 90,
      questions: [
        {
          prompt: "Pick one.",
          answers: [
            { text: "A", correct: true },
            { text: "B", correct: false }
          ]
        }
      ]
    });

    expect(normalized.targetGradePercent).toBe(90);
    expect(normalized.retakeInput.targetGradePercent).toBe(90);
  });

  it("accepts bundled theme ids and preserves them for retakes", () => {
    const quiz = buildQuiz(
      {
        ...sampleQuiz,
        theme: "harbor"
      },
      { rng: cyclingRng(), now: "2026-06-11T00:00:00.000Z" }
    );

    expect(quiz.structuredContent.theme).toBe("harbor");
    expect(quiz.retakeInput.theme).toBe("harbor");
  });

  it("rejects unknown theme ids", () => {
    expect(() =>
      normalizeQuizInput({
        ...sampleQuiz,
        theme: "neon-rain"
      })
    ).toThrow("theme must be one of");
  });

  it("allows multiple correct answers for multiple choice questions", () => {
    const quiz = buildQuiz(
      {
        questions: [
          {
            prompt: "Which values are prime?",
            type: "multiple_choice",
            answers: [
              { text: "2", correct: true, explanation: "2 is prime." },
              { text: "3", correct: true, explanation: "3 is prime." },
              { text: "4", correct: false }
            ]
          }
        ]
      },
      { rng: cyclingRng(), now: "2026-06-11T00:00:00.000Z" }
    );
    const answerKey = quiz.meta.answerKey[quiz.structuredContent.questions[0]!.id];

    expect(Array.isArray(answerKey)).toBe(true);
    expect(answerKey).toHaveLength(2);
    expect(JSON.stringify(quiz.structuredContent)).not.toContain("correct");
    expect(quiz.retakeInput.questions[0]?.answers.filter((answer) => answer.correct)).toHaveLength(2);
  });

  it("rejects questions without a correct answer", () => {
    expect(() =>
      buildQuiz({
        questions: [
          {
            prompt: "Pick one.",
            answers: [
              { text: "A", correct: false },
              { text: "B", correct: false }
            ]
          }
        ]
      })
    ).toThrow(QuizInputError);
  });

  it("enforces true_false answer count", () => {
    expect(() =>
      normalizeQuizInput({
        questions: [
          {
            prompt: "Pick one.",
            type: "true_false",
            answers: [
              { text: "True", correct: true },
              { text: "False", correct: false },
              { text: "Sometimes", correct: false }
            ]
          }
        ]
      })
    ).toThrow("true_false");
  });

  it("rejects multiple correct answers for true_false questions", () => {
    expect(() =>
      normalizeQuizInput({
        questions: [
          {
            prompt: "Pick one.",
            type: "true_false",
            answers: [
              { text: "True", correct: true },
              { text: "False", correct: true }
            ]
          }
        ]
      })
    ).toThrow("exactly one");
  });
});

function cyclingRng(): RandomInt {
  let value = 0;
  return (maxExclusive: number) => {
    value += 1;
    return value % maxExclusive;
  };
}
