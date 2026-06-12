export type QuestionType = "multiple_choice" | "true_false";

export type ChoiceInput = {
  text: string;
  correct?: boolean;
  explanation?: string;
};

export type QuestionInput = {
  prompt: string;
  type?: QuestionType;
  answers: ChoiceInput[];
  explanation?: string;
};

export type RenderQuizInput = {
  title?: string;
  questions: QuestionInput[];
  shuffleQuestions?: boolean;
  targetGradePercent?: number;
  passingScorePercent?: number;
  theme?: QuizThemeId;
};

export type QuizChoice = {
  id: string;
  text: string;
};

export type QuizQuestion = {
  id: string;
  prompt: string;
  type: QuestionType;
  choices: QuizChoice[];
};

export type QuizStructuredContent = {
  quizId: string;
  title: string;
  totalQuestions: number;
  targetGradePercent: number;
  passingScorePercent: number;
  theme?: QuizThemeId;
  questions: QuizQuestion[];
};

export type QuizHiddenMeta = {
  answerKey: Record<string, string | string[]>;
  explanations: Record<string, string>;
  choiceExplanations: Record<string, Record<string, string>>;
  generatedAt: string;
  shuffle: {
    questions: boolean;
    answers: true;
  };
};

export type BuildQuizOptions = {
  now?: string;
  rng?: RandomInt;
};

export type RandomInt = (maxExclusive: number) => number;
export type QuizThemeId = typeof QUIZ_THEME_IDS[number];

export const MAX_TITLE_LENGTH = 120;
export const MAX_QUESTIONS = 500;
export const MAX_TOTAL_TEXT_CHARS = 220_000;
export const DEFAULT_TARGET_GRADE_PERCENT = 70;
export const QUIZ_THEME_IDS = ["aurora", "paper", "sakura", "ember", "circuit", "harbor"] as const;
const MAX_PROMPT_LENGTH = 700;
const MAX_ANSWER_LENGTH = 280;
const MAX_EXPLANATION_LENGTH = 700;
const MIN_ANSWERS = 2;
const MAX_ANSWERS = 6;
const TOKEN_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const UINT32_RANGE = 0x100000000;
const RAW_STRING_LENGTH_FACTOR = 4;

export class QuizInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuizInputError";
  }
}

type NormalizedChoice = {
  text: string;
  correct: boolean;
  explanation?: string;
};

type NormalizedQuestion = {
  prompt: string;
  type: QuestionType;
  answers: NormalizedChoice[];
  explanation?: string;
};

type NormalizedQuiz = {
  title: string;
  questions: NormalizedQuestion[];
  shuffleQuestions: boolean;
  targetGradePercent: number;
  theme?: QuizThemeId;
  retakeInput: RenderQuizInput;
};

export function buildQuiz(rawInput: unknown, options: BuildQuizOptions = {}) {
  const rng = options.rng ?? secureRandomInt;
  const quiz = normalizeQuizInput(rawInput);
  const quizId = `quiz_${randomToken(12, rng)}`;
  const questionOrder = quiz.shuffleQuestions
    ? shuffleArray(quiz.questions, rng)
    : [...quiz.questions];

  const answerKey: Record<string, string | string[]> = {};
  const explanations: Record<string, string> = {};
  const choiceExplanations: Record<string, Record<string, string>> = {};
  const questions = questionOrder.map((question, questionIndex) => {
    const questionId = `q_${questionIndex.toString(36)}`;
    const correctChoiceIds: string[] = [];
    let explanation = question.explanation ?? "";
    const choices = shuffleArray(question.answers, rng).map((answer, answerIndex) => {
      const choice = {
        id: `a_${questionIndex.toString(36)}_${answerIndex.toString(36)}`,
        text: answer.text
      };

      if (answer.explanation) {
        choiceExplanations[questionId] = choiceExplanations[questionId] ?? {};
        choiceExplanations[questionId][choice.id] = answer.explanation;
      }

      if (answer.correct) {
        correctChoiceIds.push(choice.id);
        explanation ||= answer.explanation ?? "";
      }

      return choice;
    });

    answerKey[questionId] = correctChoiceIds.length === 1 ? correctChoiceIds[0] as string : correctChoiceIds;
    explanations[questionId] = explanation;

    return {
      id: questionId,
      prompt: question.prompt,
      type: question.type,
      choices
    };
  });

  return {
    structuredContent: {
      quizId,
      title: quiz.title,
      totalQuestions: questions.length,
      targetGradePercent: quiz.targetGradePercent,
      passingScorePercent: quiz.targetGradePercent,
      ...(quiz.theme ? { theme: quiz.theme } : {}),
      questions
    } satisfies QuizStructuredContent,
    meta: {
      answerKey,
      explanations,
      choiceExplanations,
      generatedAt: options.now ?? new Date().toISOString(),
      shuffle: {
        questions: quiz.shuffleQuestions,
        answers: true
      }
    } satisfies QuizHiddenMeta,
    retakeInput: quiz.retakeInput
  };
}

export function normalizeQuizInput(rawInput: unknown): NormalizedQuiz {
  const input = assertRecord(rawInput, "Input must be an object.");
  const rawQuestions = readOwnDataProperty(input, "questions", "questions");
  const rawQuestionArray = assertArray(rawQuestions, "Input must include a questions array.");
  const questionCount = readArrayLength(rawQuestionArray, "questions", "Input must include a questions array.");
  if (questionCount < 1) {
    throw new QuizInputError("Include at least one question.");
  }
  if (questionCount > MAX_QUESTIONS) {
    throw new QuizInputError(`Include at most ${MAX_QUESTIONS} questions.`);
  }

  const rawTargetGradePercent = readOwnDataProperty(input, "targetGradePercent", "targetGradePercent");
  const rawPassingScorePercent = readOwnDataProperty(input, "passingScorePercent", "passingScorePercent");
  const title = optionalString(
    readOwnDataProperty(input, "title", "title"),
    "title",
    MAX_TITLE_LENGTH
  ) ?? "Quick quiz";
  const shuffleQuestions = normalizeShuffleQuestions(
    readOwnDataProperty(input, "shuffleQuestions", "shuffleQuestions")
  );
  const targetGradePercent = normalizeTargetGrade(
    rawTargetGradePercent === undefined ? rawPassingScorePercent : rawTargetGradePercent
  );
  const theme = normalizeTheme(readOwnDataProperty(input, "theme", "theme"));
  const questions = readDenseArray(rawQuestionArray, "questions", questionCount).map((rawQuestion, index) =>
    normalizeQuestion(rawQuestion, index)
  );
  enforceTotalTextBudget(title, questions);
  const retakeInput: RenderQuizInput = {
    title,
    shuffleQuestions,
    targetGradePercent,
    ...(theme ? { theme } : {}),
    questions: questions.map((question) => ({
      prompt: question.prompt,
      type: question.type,
      explanation: question.explanation,
      answers: question.answers.map((answer) => ({
        text: answer.text,
        correct: answer.correct,
        explanation: answer.explanation
      }))
    }))
  };

  return {
    title,
    shuffleQuestions,
    targetGradePercent,
    theme,
    questions,
    retakeInput
  };
}

export function secureRandomInt(maxExclusive: number): number {
  if (!Number.isSafeInteger(maxExclusive) || maxExclusive <= 0) {
    throw new Error("maxExclusive must be a positive safe integer.");
  }
  if (maxExclusive > UINT32_RANGE) {
    throw new Error(`maxExclusive must be at most ${UINT32_RANGE}.`);
  }

  const limit = UINT32_RANGE - (UINT32_RANGE % maxExclusive);
  const buffer = new Uint32Array(1);
  let value = 0;

  do {
    crypto.getRandomValues(buffer);
    value = buffer[0] ?? 0;
  } while (value >= limit);

  return value % maxExclusive;
}

function normalizeQuestion(rawQuestion: unknown, index: number): NormalizedQuestion {
  const question = assertRecord(rawQuestion, `Question ${index + 1} must be an object.`);
  const prompt = requiredString(
    readOwnDataProperty(question, "prompt", `questions[${index}].prompt`),
    `questions[${index}].prompt`,
    MAX_PROMPT_LENGTH
  );
  const rawAnswers = readOwnDataProperty(question, "answers", `questions[${index}].answers`);

  const rawAnswerArray = assertArray(rawAnswers, `Question ${index + 1} must include an answers array.`);
  const answerCount = readArrayLength(
    rawAnswerArray,
    `questions[${index}].answers`,
    `Question ${index + 1} must include an answers array.`
  );
  if (answerCount < MIN_ANSWERS || answerCount > MAX_ANSWERS) {
    throw new QuizInputError(`Question ${index + 1} must include ${MIN_ANSWERS}-${MAX_ANSWERS} answers.`);
  }

  const explicitType = readOwnDataProperty(question, "type", `questions[${index}].type`);
  const answers = readDenseArray(rawAnswerArray, `questions[${index}].answers`, answerCount).map(
    (rawAnswer, answerIndex) => normalizeAnswer(rawAnswer, index, answerIndex)
  );
  const type = explicitType === undefined ? inferQuestionType(answers) : explicitType;
  if (type !== "multiple_choice" && type !== "true_false") {
    throw new QuizInputError(`Question ${index + 1} type must be multiple_choice or true_false.`);
  }
  if (type === "true_false" && answers.length !== 2) {
    throw new QuizInputError(`Question ${index + 1} is true_false and must include exactly two answers.`);
  }

  const correctCount = answers.filter((answer) => answer.correct).length;
  if (type === "true_false" && correctCount !== 1) {
    throw new QuizInputError(`Question ${index + 1} is true_false and must mark exactly one answer as correct.`);
  }
  if (type === "multiple_choice" && correctCount < 1) {
    throw new QuizInputError(`Question ${index + 1} must mark at least one answer as correct.`);
  }

  return {
    prompt,
    type,
    answers,
    explanation: optionalString(
      readOwnDataProperty(question, "explanation", `questions[${index}].explanation`),
      `questions[${index}].explanation`,
      MAX_EXPLANATION_LENGTH
    )
  };
}

function normalizeAnswer(rawAnswer: unknown, questionIndex: number, answerIndex: number): NormalizedChoice {
  const answer = assertRecord(
    rawAnswer,
    `questions[${questionIndex}].answers[${answerIndex}] must be an object.`
  );

  const correct = readOwnDataProperty(
    answer,
    "correct",
    `questions[${questionIndex}].answers[${answerIndex}].correct`
  );

  if (correct !== undefined && typeof correct !== "boolean") {
    throw new QuizInputError(
      `questions[${questionIndex}].answers[${answerIndex}].correct must be a boolean.`
    );
  }

  return {
    text: requiredString(
      readOwnDataProperty(answer, "text", `questions[${questionIndex}].answers[${answerIndex}].text`),
      `questions[${questionIndex}].answers[${answerIndex}].text`,
      MAX_ANSWER_LENGTH
    ),
    correct: correct === true,
    explanation: optionalString(
      readOwnDataProperty(
        answer,
        "explanation",
        `questions[${questionIndex}].answers[${answerIndex}].explanation`
      ),
      `questions[${questionIndex}].answers[${answerIndex}].explanation`,
      MAX_EXPLANATION_LENGTH
    )
  };
}

function inferQuestionType(answers: NormalizedChoice[]): QuestionType {
  if (answers.length !== 2) {
    return "multiple_choice";
  }

  const normalized = new Set(answers.map((answer) => answer.text.trim().toLowerCase()));
  return normalized.has("true") && normalized.has("false") ? "true_false" : "multiple_choice";
}

function normalizeTargetGrade(value: unknown): number {
  if (value === undefined) {
    return DEFAULT_TARGET_GRADE_PERCENT;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 100) {
    throw new QuizInputError("targetGradePercent must be an integer from 0 to 100.");
  }

  return value;
}

function normalizeShuffleQuestions(value: unknown): boolean {
  if (value === undefined) {
    return true;
  }
  if (typeof value !== "boolean") {
    throw new QuizInputError("shuffleQuestions must be a boolean.");
  }

  return value;
}

function normalizeTheme(value: unknown): QuizThemeId | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || !isQuizThemeId(value)) {
    throw new QuizInputError(`theme must be one of: ${QUIZ_THEME_IDS.join(", ")}.`);
  }

  return value;
}

function isQuizThemeId(value: string): value is QuizThemeId {
  return (QUIZ_THEME_IDS as readonly string[]).includes(value);
}

function assertRecord(value: unknown, message: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new QuizInputError(message);
  }

  let prototype: object | null;
  try {
    prototype = Object.getPrototypeOf(value);
  } catch {
    throw new QuizInputError(message);
  }
  if (prototype !== Object.prototype && prototype !== null) {
    throw new QuizInputError(message);
  }

  return value as Record<string, unknown>;
}

function readOwnDataProperty(record: Record<string, unknown>, key: string, path: string): unknown {
  const descriptor = getOwnDescriptor(record, key, path);
  if (!descriptor) {
    return undefined;
  }
  if (!("value" in descriptor)) {
    throw new QuizInputError(`${path} must be a data property.`);
  }

  return descriptor.value;
}

function assertArray(value: unknown, message: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new QuizInputError(message);
  }

  let prototype: object | null;
  try {
    prototype = Object.getPrototypeOf(value);
  } catch {
    throw new QuizInputError(message);
  }
  if (prototype !== Array.prototype) {
    throw new QuizInputError(message);
  }

  return value;
}

function readArrayLength(items: readonly unknown[], path: string, message: string): number {
  const descriptor = getOwnDescriptor(items, "length", `${path}.length`);
  if (!descriptor || !("value" in descriptor) || !Number.isSafeInteger(descriptor.value) || descriptor.value < 0) {
    throw new QuizInputError(message);
  }

  return descriptor.value;
}

function readDenseArray(items: readonly unknown[], path: string, length: number): unknown[] {
  const values: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const itemPath = `${path}[${index}]`;
    const descriptor = getOwnDescriptor(items, String(index), itemPath);
    if (!descriptor) {
      throw new QuizInputError(`${itemPath} must be provided.`);
    }
    if (!("value" in descriptor)) {
      throw new QuizInputError(`${itemPath} must be a data property.`);
    }
    values.push(descriptor.value);
  }

  return values;
}

function getOwnDescriptor(value: object, key: string, path: string): PropertyDescriptor | undefined {
  try {
    return Object.getOwnPropertyDescriptor(value, key);
  } catch {
    throw new QuizInputError(`${path} could not be read.`);
  }
}

function requiredString(value: unknown, path: string, maxLength: number): string {
  if (typeof value !== "string") {
    throw new QuizInputError(`${path} must be a string.`);
  }
  if (value.length > maxLength * RAW_STRING_LENGTH_FACTOR) {
    throw new QuizInputError(`${path} is too large before cleanup.`);
  }

  const text = cleanText(value);
  if (!text) {
    throw new QuizInputError(`${path} cannot be empty.`);
  }
  if (text.length > maxLength) {
    throw new QuizInputError(`${path} must be ${maxLength} characters or fewer.`);
  }

  return text;
}

function cleanText(value: string): string {
  return value
    .normalize("NFC")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "")
    .replace(/[\u202A-\u202E\u2066-\u2069]/g, "")
    .replace(/[ \t\r\n]+/g, " ")
    .trim();
}

function enforceTotalTextBudget(title: string, questions: NormalizedQuestion[]): void {
  let total = title.length;
  for (const question of questions) {
    total += question.prompt.length + (question.explanation?.length ?? 0);
    for (const answer of question.answers) {
      total += answer.text.length + (answer.explanation?.length ?? 0);
    }
  }

  if (total > MAX_TOTAL_TEXT_CHARS) {
    throw new QuizInputError(
      `Quiz text is too large. Keep combined quiz text under ${MAX_TOTAL_TEXT_CHARS} characters.`
    );
  }
}

function optionalString(value: unknown, path: string, maxLength: number): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  return requiredString(value, path, maxLength);
}

function shuffleArray<T>(items: readonly T[], rng: RandomInt): T[] {
  const output = [...items];
  for (let index = output.length - 1; index > 0; index -= 1) {
    const swapIndex = randomIndex(index + 1, rng);
    [output[index], output[swapIndex]] = [output[swapIndex] as T, output[index] as T];
  }

  return output;
}

function randomToken(length: number, rng: RandomInt): string {
  let token = "";
  for (let index = 0; index < length; index += 1) {
    token += TOKEN_ALPHABET[randomIndex(TOKEN_ALPHABET.length, rng)] ?? "0";
  }

  return token;
}

function randomIndex(maxExclusive: number, rng: RandomInt): number {
  const value = rng(maxExclusive);
  if (!Number.isSafeInteger(value) || value < 0 || value >= maxExclusive) {
    throw new Error("Random integer generator returned an out-of-range value.");
  }

  return value;
}
