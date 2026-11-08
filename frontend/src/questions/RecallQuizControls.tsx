import type { useRecallQuiz } from './useRecallQuiz';
import './quiz.css';

export function RecallQuizControls({ quiz, ready }: { quiz: ReturnType<typeof useRecallQuiz>; ready: boolean }) {
  const active = quiz.session && !quiz.totals?.finished;
  return <section className="recall-quiz" aria-label="Recall quiz" data-testid="recall-quiz">
    <label>Answer format{' '}
      <select aria-label="Answer format" value={quiz.format} disabled={!!active} onChange={(event) => quiz.setFormat(event.target.value as 'typed' | 'multiple_choice')}>
        <option value="typed">Text answer — self-check</option>
        <option value="multiple_choice">Four choices — automatically marked</option>
      </select>
    </label>{' '}
    <button type="button" disabled={!ready || !quiz.availableCount} onClick={quiz.start}>
      {quiz.session ? 'Start new quiz' : 'Start quiz'} for {quiz.availableCount} saved {quiz.availableCount === 1 ? 'moment' : 'moments'}
    </button>
    {quiz.session && <button type="button" onClick={quiz.end}>End this quiz</button>}
    <p>Starting a quiz requests one question per saved moment. Its moment list stays fixed; new bookmarks join the next quiz.</p>
    {quiz.totals && <div aria-live="polite">
      <p>{quiz.totals.answered} of {quiz.totals.eligible} questions answered{quiz.totals.waiting ? `; ${quiz.totals.waiting} still preparing` : ''}.</p>
      {!!quiz.totals.skipped && <p>{quiz.totals.skipped} nonteaching {quiz.totals.skipped === 1 ? 'passage skipped' : 'passages skipped'}; bookmarks stay saved.</p>}
      {!!quiz.totals.insufficient && <p>{quiz.totals.insufficient} {quiz.totals.insufficient === 1 ? 'moment lacks' : 'moments lack'} enough transcript for a question.</p>}
      {!!quiz.totals.unavailable && <p>{quiz.totals.unavailable} {quiz.totals.unavailable === 1 ? 'question unavailable' : 'questions unavailable'}; excluded from accuracy. Retry from the moment card.</p>}
      {quiz.totals.finished && !quiz.totals.eligible && <p>No answerable questions were prepared. No accuracy score is reported.</p>}
      {quiz.totals.complete && <p className="recall-quiz__score" data-testid="quiz-accuracy">
        {quiz.session!.format === 'typed' ? 'Self-assessed accuracy' : 'Quiz accuracy'}: <strong>{quiz.totals.accuracy}%</strong> ({quiz.totals.correct}/{quiz.totals.eligible}).
      </p>}
    </div>}
  </section>;
}
