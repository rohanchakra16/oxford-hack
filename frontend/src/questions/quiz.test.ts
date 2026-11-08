import { describe, expect, it } from 'vitest';
import type { GeneratedQuestion } from './client';
import { choiceOrder, hasChoices, questionFingerprint, quizTotals, type QuizSession } from './quiz';
import type { QuestionSnapshot } from './store';

const question: GeneratedQuestion = { question: 'What happens to current?', suggestedAnswer: 'It decreases.',
  supportingQuote: 'increasing resistance reduces current', quoteVerified: true, model: 'm', promptVersion: 'v3', cached: false,
  choices: ['It decreases.', 'It increases.', 'It stays constant.', 'It doubles.'], correctChoiceIndex: 0 };
const excerpt = { startMediaS: 0, endMediaS: 10, text: 'A synthetic transcript.' };
const ready = { status: 'ready' as const, excerpt, result: question };
const session = (format: QuizSession['format'] = 'multiple_choice'): QuizSession => ({ id: 'quiz', scope: {}, format, ids: ['b1', 'b2'], answers: new Map() });

describe('quiz accuracy', () => {
  it('withholds the final score until every ready question is answered', () => {
    const quiz = session();
    const entries: QuestionSnapshot = new Map([['b1', ready], ['b2', ready]]);
    quiz.answers = new Map([['b1', { fingerprint: questionFingerprint(question), response: 0, correct: true }]]);
    expect(quizTotals(quiz, entries)).toMatchObject({ answered: 1, eligible: 2, accuracy: null, complete: false });
    quiz.answers = new Map([...quiz.answers, ['b2', { fingerprint: questionFingerprint(question), response: 2, correct: false }]]);
    expect(quizTotals(quiz, entries)).toMatchObject({ correct: 1, answered: 2, accuracy: 50, complete: true });
  });
  it('waits for generating questions and excludes nonteaching or failed moments', () => {
    const quiz = session();
    quiz.ids = ['b1', 'b2', 'b3', 'b4'];
    const entries = new Map<string, typeof ready | { status: 'generating'; excerpt: typeof excerpt } | { status: 'skipped_non_instructional'; excerpt: typeof excerpt; reason: string } | { status: 'unavailable'; excerpt: typeof excerpt; code: 'timeout'; message: string; retryAfterS: null }>([
      ['b1', ready], ['b2', { status: 'generating', excerpt }],
      ['b3', { status: 'skipped_non_instructional', excerpt, reason: 'A break.' }],
      ['b4', { status: 'unavailable', excerpt, code: 'timeout', message: 'Timeout', retryAfterS: null }],
    ]);
    quiz.answers = new Map([['b1', { fingerprint: questionFingerprint(question), response: 0, correct: true }]]);
    expect(quizTotals(quiz, entries)).toMatchObject({ accuracy: null, waiting: 1, skipped: 1, unavailable: 1 });
    entries.set('b2', { status: 'skipped_non_instructional', excerpt, reason: 'Logistics.' });
    expect(quizTotals(quiz, entries)).toMatchObject({ eligible: 1, accuracy: 100, skipped: 2, unavailable: 1 });
  });
  it('does not count newly arrived bookmarks or stale answers for a changed question', () => {
    const quiz = session();
    const entries: QuestionSnapshot = new Map([['b1', ready], ['b2', ready], ['new-bookmark', ready]]);
    quiz.answers = new Map([
      ['b1', { fingerprint: questionFingerprint({ ...question, suggestedAnswer: 'An older answer.' }), response: 0, correct: true }],
      ['b2', { fingerprint: questionFingerprint(question), response: 0, correct: true }],
    ]);
    expect(quizTotals(quiz, entries)).toMatchObject({ eligible: 2, answered: 1, accuracy: null });
  });
  it('requires an explicit self-check for typed answers', () => {
    const quiz = session('typed');
    quiz.ids = ['b1'];
    quiz.answers = new Map([['b1', { fingerprint: questionFingerprint(question), response: 'My explanation.', correct: null }]]);
    expect(quizTotals(quiz, new Map([['b1', ready]]))).toMatchObject({ answered: 0, accuracy: null });
    quiz.answers = new Map([['b1', { fingerprint: questionFingerprint(question), response: 'My explanation.', correct: false }]]);
    expect(quizTotals(quiz, new Map([['b1', ready]]))).toMatchObject({ answered: 1, accuracy: 0, complete: true });
  });
  it('does not report zero percent when no questions can be prepared', () => {
    const quiz = session();
    expect(quizTotals(quiz, new Map([['b1', { status: 'no_transcript' }], ['b2', { status: 'insufficient_context', excerpt: null }]])))
      .toMatchObject({ eligible: 0, complete: false, finished: true, accuracy: null });
  });
});

describe('four-choice answers', () => {
  it('rejects missing, duplicate or invalid answer keys', () => {
    expect(hasChoices(question)).toBe(true);
    expect(hasChoices({ ...question, choices: ['Same', 'Same', 'Other', 'Fourth'] })).toBe(false);
    expect(hasChoices({ ...question, correctChoiceIndex: 4 })).toBe(false);
    expect(hasChoices({ ...question, choices: undefined })).toBe(false);
  });
  it('keeps all canonical answer indexes and varies their display positions between quizzes', () => {
    const first = choiceOrder('quiz-one:b1');
    expect([...first].sort()).toEqual([0, 1, 2, 3]);
    expect(choiceOrder('quiz-one:b1')).toEqual(first);
    const positions = new Set(Array.from({ length: 20 }, (_, n) => choiceOrder(`quiz-${n}:b1`).indexOf(0)));
    expect(positions.size).toBeGreaterThan(1);
  });
});
