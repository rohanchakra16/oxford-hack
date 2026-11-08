import type { GeneratedQuestion } from './client';
import type { QuestionSnapshot } from './store';

export type QuizFormat = 'typed' | 'multiple_choice';
export interface QuizAnswer { fingerprint: string; response: string | number; correct: boolean | null }
export interface QuizSession {
  id: string;
  scope: object;
  format: QuizFormat;
  ids: readonly string[];
  answers: ReadonlyMap<string, QuizAnswer>;
}
export interface QuestionInteraction {
  sessionId: string;
  format: QuizFormat;
  answer: QuizAnswer | undefined;
  order: readonly number[];
  submitTyped(text: string): void;
  submitChoice(index: number): void;
  selfCheck(correct: boolean): void;
}

export const questionFingerprint = (q: GeneratedQuestion) =>
  JSON.stringify([q.question, q.suggestedAnswer, q.model, q.promptVersion, q.choices, q.correctChoiceIndex]);

export function hasChoices(q: GeneratedQuestion): boolean {
  return Array.isArray(q.choices) && q.choices.length === 4
    && q.choices.every((choice) => typeof choice === 'string' && choice.trim().length > 0)
    && new Set(q.choices.map((choice) => choice.trim().toLowerCase())).size === 4
    && Number.isInteger(q.correctChoiceIndex) && q.correctChoiceIndex! >= 0 && q.correctChoiceIndex! < 4;
}

/** Stable per quiz/question, changing between quizzes; never shuffle while answering. */
export function choiceOrder(seed: string): number[] {
  let state = 2166136261;
  for (const character of seed) state = Math.imul(state ^ character.charCodeAt(0), 16777619) >>> 0;
  const order = [0, 1, 2, 3];
  for (let i = 3; i > 0; i -= 1) {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    const j = Math.floor((state >>> 0) / 4294967296 * (i + 1));
    [order[i], order[j]] = [order[j]!, order[i]!];
  }
  return order;
}

export function quizTotals(session: QuizSession, entries: QuestionSnapshot) {
  let eligible = 0, answered = 0, correct = 0, waiting = 0, skipped = 0, unavailable = 0, insufficient = 0;
  for (const id of session.ids) {
    const entry = entries.get(id);
    if (!entry || entry.status === 'generating') { waiting += 1; continue; }
    if (entry.status === 'skipped_non_instructional') { skipped += 1; continue; }
    if (entry.status === 'unavailable') { unavailable += 1; continue; }
    if (entry.status !== 'ready') { insufficient += 1; continue; }
    if (session.format === 'multiple_choice' && !hasChoices(entry.result)) { unavailable += 1; continue; }
    eligible += 1;
    const answer = session.answers.get(id);
    if (answer && answer.fingerprint === questionFingerprint(entry.result) && answer.correct !== null) {
      answered += 1;
      if (answer.correct) correct += 1;
    }
  }
  const complete = waiting === 0 && eligible > 0 && answered === eligible;
  return { eligible, answered, correct, waiting, skipped, unavailable, insufficient, complete,
    finished: waiting === 0 && (eligible === 0 || complete), accuracy: complete ? Math.round(correct / eligible * 100) : null };
}
