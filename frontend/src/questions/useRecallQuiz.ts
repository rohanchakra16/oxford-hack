import { useCallback, useMemo, useState } from 'react';
import type { GeneratedQuestion } from './client';
import type { BookmarkRange } from './excerpt';
import type { QuestionSnapshot } from './store';
import { choiceOrder, hasChoices, questionFingerprint, quizTotals, type QuestionInteraction, type QuizFormat, type QuizSession } from './quiz';

export function useRecallQuiz(scope: object, entries: QuestionSnapshot, bookmarks: readonly BookmarkRange[], ready: boolean,
  generate: (bookmark: BookmarkRange) => void) {
  const [format, setFormat] = useState<QuizFormat>('typed');
  const [saved, setSaved] = useState<QuizSession | null>(null);
  const session = saved?.scope === scope ? saved : null;
  const totals = session ? quizTotals(session, entries) : null;

  const begin = useCallback((included: readonly BookmarkRange[]) => {
    if (!ready || included.length === 0) return;
    const ids = [...new Set(included.map((bookmark) => bookmark.bookmarkId))];
    setSaved({ id: crypto.randomUUID(), scope, format, ids, answers: new Map() });
    for (const id of ids) generate(included.find((bookmark) => bookmark.bookmarkId === id)!);
  }, [ready, scope, format, generate]);
  const start = useCallback(() => begin(bookmarks), [begin, bookmarks]);
  const end = useCallback(() => setSaved(null), []);
  const requestOne = useCallback((bookmark: BookmarkRange) => {
    if (!ready) return;
    if (session?.ids.includes(bookmark.bookmarkId)) generate(bookmark);
    else if (!session || totals?.finished) begin([bookmark]);
  }, [ready, session, totals?.finished, begin, generate]);

  const interaction = useCallback((id: string, question: GeneratedQuestion): QuestionInteraction | undefined => {
    if (!session?.ids.includes(id) || (session.format === 'multiple_choice' && !hasChoices(question))) return;
    const fingerprint = questionFingerprint(question);
    const found = session.answers.get(id);
    const answer = found?.fingerprint === fingerprint ? found : undefined;
    const submit = (response: string | number, correct: boolean | null) => setSaved((previous) => {
      if (!previous || previous.id !== session.id || previous.scope !== scope) return previous;
      if (previous.answers.get(id)?.fingerprint === fingerprint) return previous;
      return { ...previous, answers: new Map(previous.answers).set(id, { fingerprint, response, correct }) };
    });
    return {
      sessionId: session.id, format: session.format, answer, order: choiceOrder(`${session.id}:${id}`),
      submitTyped(text) { if (session.format === 'typed' && text.trim() && text.length <= 2000) submit(text.trim(), null); },
      submitChoice(index) {
        if (session.format === 'multiple_choice' && Number.isInteger(index) && index >= 0 && index < 4) submit(index, index === question.correctChoiceIndex);
      },
      selfCheck(correct) {
        if (session.format !== 'typed') return;
        setSaved((previous) => {
          const current = previous?.answers.get(id);
          if (!previous || previous.id !== session.id || previous.scope !== scope || !current
            || current.fingerprint !== fingerprint || current.correct !== null) return previous;
          return { ...previous, answers: new Map(previous.answers).set(id, { ...current, correct }) };
        });
      },
    };
  }, [session, scope]);

  return useMemo(() => ({ format, setFormat, session, totals, start, end, interaction, requestOne,
    availableCount: new Set(bookmarks.map((bookmark) => bookmark.bookmarkId)).size,
    canRequest: (id: string) => !session || !!totals?.finished || session.ids.includes(id) }),
  [format, session, totals, start, end, interaction, requestOne, bookmarks]);
}
