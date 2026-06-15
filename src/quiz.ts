export type QuestionType = "multiple_choice" | "true_false" | "matching" | "sorting";
export type QuestionTypeInput = QuestionType | "mc" | "tf" | "match" | "sort";

export type ChoiceInput = {
  text?: string;
  t?: string;
  correct?: boolean;
  c?: boolean;
  match?: string;
  m?: string;
  answer?: string;
  right?: string;
  r?: string;
  explanation?: string;
  e?: string;
};

export type MatchingPairInput = {
  prompt?: string;
  q?: string;
  term?: string;
  left?: string;
  l?: string;
  text?: string;
  t?: string;
  answer?: string;
  match?: string;
  right?: string;
  r?: string;
  m?: string;
  explanation?: string;
  e?: string;
};

export type SortItemInput = {
  text?: string;
  t?: string;
  explanation?: string;
  e?: string;
};

export type QuestionInput = {
  prompt?: string;
  q?: string;
  type?: QuestionTypeInput;
  answers: ChoiceInput[];
  a?: ChoiceInput[];
  pairs?: MatchingPairInput[];
  p?: MatchingPairInput[];
  items?: SortItemInput[];
  i?: SortItemInput[];
  explanation?: string;
  e?: string;
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

export type QuizMatchTarget = {
  id: string;
  text: string;
};

export type QuizQuestion = {
  id: string;
  prompt: string;
  type: QuestionType;
  choices: QuizChoice[];
  targets?: QuizMatchTarget[];
};

export type QuizAnswerKey =
  | string
  | string[]
  | {
    type: "matching";
    matches: Record<string, string>;
  }
  | {
    type: "sorting";
    order: string[];
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
  answerKey: Record<string, QuizAnswerKey>;
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
const MIN_MATCHING_PAIRS = 2;
const MAX_MATCHING_PAIRS = 10;
const MIN_SORT_ITEMS = 2;
const MAX_SORT_ITEMS = 10;
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

type NormalizedMatchingPair = {
  prompt: string;
  answer: string;
  explanation?: string;
};

type NormalizedSortItem = {
  text: string;
  explanation?: string;
};

type NormalizedQuestion = {
  prompt: string;
  type: QuestionType;
  answers: NormalizedChoice[];
  pairs?: NormalizedMatchingPair[];
  items?: NormalizedSortItem[];
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

  const answerKey: Record<string, QuizAnswerKey> = {};
  const explanations: Record<string, string> = {};
  const choiceExplanations: Record<string, Record<string, string>> = {};
  const questions = questionOrder.map((question, questionIndex) => {
    const questionId = `q_${questionIndex.toString(36)}`;
    if (question.type === "matching") {
      const pairs = question.pairs ?? [];
      const pairRefs = pairs.map((pair, pairIndex) => ({
        pair,
        pairIndex,
        targetId: `m_${questionIndex.toString(36)}_${pairIndex.toString(36)}`,
        choiceId: `a_${questionIndex.toString(36)}_${pairIndex.toString(36)}`
      }));
      const targets = shuffleArray(pairRefs, rng).map((item) => ({
        id: item.targetId,
        text: item.pair.prompt
      }));
      const choices = shuffleArray(pairRefs, rng).map((item) => {
        if (item.pair.explanation) {
          choiceExplanations[questionId] = choiceExplanations[questionId] ?? {};
          choiceExplanations[questionId][item.choiceId] = item.pair.explanation;
        }
        return {
          id: item.choiceId,
          text: item.pair.answer
        };
      });
      const matches: Record<string, string> = {};
      for (const item of pairRefs) {
        matches[item.targetId] = item.choiceId;
      }
      answerKey[questionId] = { type: "matching", matches };
      explanations[questionId] = question.explanation ?? pairs.find((pair) => pair.explanation)?.explanation ?? "";

      return {
        id: questionId,
        prompt: question.prompt,
        type: question.type,
        targets,
        choices
      };
    }

    if (question.type === "sorting") {
      const items = question.items ?? [];
      const itemRefs = items.map((item, itemIndex) => ({
        item,
        choiceId: `a_${questionIndex.toString(36)}_${itemIndex.toString(36)}`
      }));
      const choices = shuffleArray(itemRefs, rng).map((item) => {
        if (item.item.explanation) {
          choiceExplanations[questionId] = choiceExplanations[questionId] ?? {};
          choiceExplanations[questionId][item.choiceId] = item.item.explanation;
        }
        return {
          id: item.choiceId,
          text: item.item.text
        };
      });
      answerKey[questionId] = { type: "sorting", order: itemRefs.map((item) => item.choiceId) };
      explanations[questionId] = question.explanation ?? items.find((item) => item.explanation)?.explanation ?? "";

      return {
        id: questionId,
        prompt: question.prompt,
        type: question.type,
        choices
      };
    }

    const correctChoiceIds: string[] = [];
    let explanation = question.explanation ?? "";
    const choices = shuffleArray(question.answers ?? [], rng).map((answer, answerIndex) => {
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
    questions: questions.map((question) => {
      if (question.type === "matching") {
        return {
          prompt: question.prompt,
          type: question.type,
          explanation: question.explanation,
          answers: [],
          pairs: (question.pairs ?? []).map((pair) => ({
            prompt: pair.prompt,
            answer: pair.answer,
            explanation: pair.explanation
          }))
        };
      }
      if (question.type === "sorting") {
        return {
          prompt: question.prompt,
          type: question.type,
          explanation: question.explanation,
          answers: [],
          items: (question.items ?? []).map((item) => ({
            text: item.text,
            explanation: item.explanation
          }))
        };
      }
      return {
        prompt: question.prompt,
        type: question.type,
        explanation: question.explanation,
        answers: (question.answers ?? []).map((answer) => ({
          text: answer.text,
          correct: answer.correct,
          explanation: answer.explanation
        }))
      };
    })
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
    readOwnDataPropertyAlias(question, "prompt", "q", `questions[${index}].prompt`, `questions[${index}].q`),
    `questions[${index}].prompt`,
    MAX_PROMPT_LENGTH
  );
  const explicitType = normalizeQuestionType(readOwnDataProperty(question, "type", `questions[${index}].type`));
  const explanation = optionalString(
    readOwnDataPropertyAlias(
      question,
      "explanation",
      "e",
      `questions[${index}].explanation`,
      `questions[${index}].e`
    ),
    `questions[${index}].explanation`,
    MAX_EXPLANATION_LENGTH
  );

  if (explicitType === "matching" || (!explicitType && hasAnyOwnDataProperty(question, ["pairs", "p"]))) {
    return normalizeMatchingQuestion(question, index, prompt, explanation);
  }
  if (explicitType === "sorting" || (!explicitType && hasAnyOwnDataProperty(question, ["items", "i"]))) {
    return normalizeSortingQuestion(question, index, prompt, explanation);
  }

  const rawAnswers = readOwnDataPropertyAlias(
    question,
    "answers",
    "a",
    `questions[${index}].answers`,
    `questions[${index}].a`
  );
  const rawAnswerArray = assertArray(rawAnswers, `Question ${index + 1} must include an answers array.`);
  const answerCount = readArrayLength(
    rawAnswerArray,
    `questions[${index}].answers`,
    `Question ${index + 1} must include an answers array.`
  );
  if (answerCount < MIN_ANSWERS || answerCount > MAX_ANSWERS) {
    throw new QuizInputError(`Question ${index + 1} must include ${MIN_ANSWERS}-${MAX_ANSWERS} answers.`);
  }

  const answers = readDenseArray(rawAnswerArray, `questions[${index}].answers`, answerCount).map(
    (rawAnswer, answerIndex) => normalizeAnswer(rawAnswer, index, answerIndex)
  );
  const type = explicitType === undefined ? inferQuestionType(answers) : explicitType;
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
    explanation
  };
}

function normalizeMatchingQuestion(
  question: Record<string, unknown>,
  questionIndex: number,
  prompt: string,
  explanation: string | undefined
): NormalizedQuestion {
  const rawPairs = readOwnDataPropertyAliases(question, [
    ["pairs", `questions[${questionIndex}].pairs`],
    ["p", `questions[${questionIndex}].p`],
    ["answers", `questions[${questionIndex}].answers`],
    ["a", `questions[${questionIndex}].a`]
  ]);
  const rawPairArray = assertArray(rawPairs, `Question ${questionIndex + 1} must include a pairs array.`);
  const pairCount = readArrayLength(
    rawPairArray,
    `questions[${questionIndex}].pairs`,
    `Question ${questionIndex + 1} must include a pairs array.`
  );
  if (pairCount < MIN_MATCHING_PAIRS || pairCount > MAX_MATCHING_PAIRS) {
    throw new QuizInputError(
      `Question ${questionIndex + 1} must include ${MIN_MATCHING_PAIRS}-${MAX_MATCHING_PAIRS} matching pairs.`
    );
  }

  const pairs = readDenseArray(rawPairArray, `questions[${questionIndex}].pairs`, pairCount).map(
    (rawPair, pairIndex) => normalizeMatchingPair(rawPair, questionIndex, pairIndex)
  );
  rejectDuplicateTexts(
    pairs.map((pair) => pair.prompt),
    `Question ${questionIndex + 1} matching prompts must be unique.`
  );
  rejectDuplicateTexts(
    pairs.map((pair) => pair.answer),
    `Question ${questionIndex + 1} matching answers must be unique.`
  );

  return {
    prompt,
    type: "matching",
    answers: [],
    pairs,
    explanation
  };
}

function normalizeSortingQuestion(
  question: Record<string, unknown>,
  questionIndex: number,
  prompt: string,
  explanation: string | undefined
): NormalizedQuestion {
  const rawItems = readOwnDataPropertyAliases(question, [
    ["items", `questions[${questionIndex}].items`],
    ["i", `questions[${questionIndex}].i`],
    ["answers", `questions[${questionIndex}].answers`],
    ["a", `questions[${questionIndex}].a`]
  ]);
  const rawItemArray = assertArray(rawItems, `Question ${questionIndex + 1} must include an items array.`);
  const itemCount = readArrayLength(
    rawItemArray,
    `questions[${questionIndex}].items`,
    `Question ${questionIndex + 1} must include an items array.`
  );
  if (itemCount < MIN_SORT_ITEMS || itemCount > MAX_SORT_ITEMS) {
    throw new QuizInputError(
      `Question ${questionIndex + 1} must include ${MIN_SORT_ITEMS}-${MAX_SORT_ITEMS} sorting items.`
    );
  }

  const items = readDenseArray(rawItemArray, `questions[${questionIndex}].items`, itemCount).map(
    (rawItem, itemIndex) => normalizeSortItem(rawItem, questionIndex, itemIndex)
  );
  rejectDuplicateTexts(
    items.map((item) => item.text),
    `Question ${questionIndex + 1} sorting items must be unique.`
  );

  return {
    prompt,
    type: "sorting",
    answers: [],
    items,
    explanation
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
  ) ?? readOwnDataProperty(
    answer,
    "c",
    `questions[${questionIndex}].answers[${answerIndex}].c`
  );

  if (correct !== undefined && typeof correct !== "boolean") {
    throw new QuizInputError(
      `questions[${questionIndex}].answers[${answerIndex}].correct must be a boolean.`
    );
  }

  return {
    text: requiredString(
      readOwnDataPropertyAlias(
        answer,
        "text",
        "t",
        `questions[${questionIndex}].answers[${answerIndex}].text`,
        `questions[${questionIndex}].answers[${answerIndex}].t`
      ),
      `questions[${questionIndex}].answers[${answerIndex}].text`,
      MAX_ANSWER_LENGTH
    ),
    correct: correct === true,
    explanation: optionalString(
      readOwnDataPropertyAlias(
        answer,
        "explanation",
        "e",
        `questions[${questionIndex}].answers[${answerIndex}].explanation`,
        `questions[${questionIndex}].answers[${answerIndex}].e`
      ),
      `questions[${questionIndex}].answers[${answerIndex}].explanation`,
      MAX_EXPLANATION_LENGTH
    )
  };
}

function normalizeMatchingPair(rawPair: unknown, questionIndex: number, pairIndex: number): NormalizedMatchingPair {
  const pair = assertRecord(
    rawPair,
    `questions[${questionIndex}].pairs[${pairIndex}] must be an object.`
  );
  const promptPath = `questions[${questionIndex}].pairs[${pairIndex}].prompt`;
  const answerPath = `questions[${questionIndex}].pairs[${pairIndex}].match`;

  return {
    prompt: requiredString(
      readOwnDataPropertyAliases(pair, [
        ["prompt", promptPath],
        ["q", `questions[${questionIndex}].pairs[${pairIndex}].q`],
        ["term", `questions[${questionIndex}].pairs[${pairIndex}].term`],
        ["left", `questions[${questionIndex}].pairs[${pairIndex}].left`],
        ["l", `questions[${questionIndex}].pairs[${pairIndex}].l`],
        ["text", `questions[${questionIndex}].pairs[${pairIndex}].text`],
        ["t", `questions[${questionIndex}].pairs[${pairIndex}].t`]
      ]),
      promptPath,
      MAX_ANSWER_LENGTH
    ),
    answer: requiredString(
      readOwnDataPropertyAliases(pair, [
        ["match", answerPath],
        ["m", `questions[${questionIndex}].pairs[${pairIndex}].m`],
        ["answer", `questions[${questionIndex}].pairs[${pairIndex}].answer`],
        ["right", `questions[${questionIndex}].pairs[${pairIndex}].right`],
        ["r", `questions[${questionIndex}].pairs[${pairIndex}].r`]
      ]),
      answerPath,
      MAX_ANSWER_LENGTH
    ),
    explanation: optionalString(
      readOwnDataPropertyAlias(
        pair,
        "explanation",
        "e",
        `questions[${questionIndex}].pairs[${pairIndex}].explanation`,
        `questions[${questionIndex}].pairs[${pairIndex}].e`
      ),
      `questions[${questionIndex}].pairs[${pairIndex}].explanation`,
      MAX_EXPLANATION_LENGTH
    )
  };
}

function normalizeSortItem(rawItem: unknown, questionIndex: number, itemIndex: number): NormalizedSortItem {
  const item = assertRecord(
    rawItem,
    `questions[${questionIndex}].items[${itemIndex}] must be an object.`
  );

  return {
    text: requiredString(
      readOwnDataPropertyAlias(
        item,
        "text",
        "t",
        `questions[${questionIndex}].items[${itemIndex}].text`,
        `questions[${questionIndex}].items[${itemIndex}].t`
      ),
      `questions[${questionIndex}].items[${itemIndex}].text`,
      MAX_ANSWER_LENGTH
    ),
    explanation: optionalString(
      readOwnDataPropertyAlias(
        item,
        "explanation",
        "e",
        `questions[${questionIndex}].items[${itemIndex}].explanation`,
        `questions[${questionIndex}].items[${itemIndex}].e`
      ),
      `questions[${questionIndex}].items[${itemIndex}].explanation`,
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

function normalizeQuestionType(value: unknown): QuestionType | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === "multiple_choice" || value === "mc") {
    return "multiple_choice";
  }
  if (value === "true_false" || value === "tf") {
    return "true_false";
  }
  if (value === "matching" || value === "match") {
    return "matching";
  }
  if (value === "sorting" || value === "sort") {
    return "sorting";
  }

  throw new QuizInputError("Question type must be multiple_choice, true_false, matching, sorting, mc, tf, match, or sort.");
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

function readOwnDataPropertyAlias(
  record: Record<string, unknown>,
  key: string,
  alias: string,
  path: string,
  aliasPath: string
): unknown {
  const value = readOwnDataProperty(record, key, path);
  return value === undefined ? readOwnDataProperty(record, alias, aliasPath) : value;
}

function readOwnDataPropertyAliases(
  record: Record<string, unknown>,
  entries: Array<[key: string, path: string]>
): unknown {
  for (const [key, path] of entries) {
    const value = readOwnDataProperty(record, key, path);
    if (value !== undefined) {
      return value;
    }
  }

  return undefined;
}

function hasAnyOwnDataProperty(record: Record<string, unknown>, keys: string[]): boolean {
  for (const key of keys) {
    if (getOwnDescriptor(record, key, key)) {
      return true;
    }
  }

  return false;
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
    for (const answer of question.answers ?? []) {
      total += answer.text.length + (answer.explanation?.length ?? 0);
    }
    for (const pair of question.pairs ?? []) {
      total += pair.prompt.length + pair.answer.length + (pair.explanation?.length ?? 0);
    }
    for (const item of question.items ?? []) {
      total += item.text.length + (item.explanation?.length ?? 0);
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

function rejectDuplicateTexts(values: string[], message: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = value.trim().toLowerCase();
    if (seen.has(normalized)) {
      throw new QuizInputError(message);
    }
    seen.add(normalized);
  }
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
