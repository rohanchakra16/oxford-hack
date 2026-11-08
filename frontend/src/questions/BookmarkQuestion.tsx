/**
 * Minimal, unstyled view of one bookmark's question. Owner: Person 4 (@aryanmorarji).
 * Placement and styling belong to the product composition (@rohanchakra16 / @Betty505); this
 * only fixes the wording, states and test ids. The answer is hidden until the student asks.
 */
import { useState } from 'react';
import type { QuestionEntry } from './store';
import type { GeneratedQuestion } from './client';

export interface BookmarkQuestionProps {
  entry: QuestionEntry | undefined;
  onRetry?: () => void;
}

export function BookmarkQuestion({ entry, onRetry }: BookmarkQuestionProps) {
  const [revealed, setRevealed] = useState<GeneratedQuestion | null>(null);
  if (!entry) return null;
  const status = entry.status;
  const showAnswer = status === 'ready' && revealed === entry.result;
  return (
    <div className="bookmark-question" data-testid="bookmark-question" data-status={status}>
      {status === 'generating' && <p role="status">Preparing lecture context and writing a recall question…</p>}
      {status === 'no_transcript' && <p>Open a transcript to get a recall question for this moment.</p>}
      {status === 'insufficient_context' && <p>Not enough transcript here to ask a useful question.</p>}
      {status === 'skipped_non_instructional' && <p data-testid="bookmark-question-skipped">No question for this passage: {entry.reason} Your bookmark stays saved.</p>}
      {status === 'unavailable' && (
        <p role="status">
          Question unavailable: {entry.message}{' '}
          {onRetry && <button type="button" onClick={onRetry} data-testid="bookmark-question-retry">Try again</button>}
        </p>
      )}
      {status === 'ready' && (
        <>
          <p className="bookmark-question-text" data-testid="bookmark-question-text">{entry.result.question}</p>
          <button type="button" aria-expanded={showAnswer} onClick={() => setRevealed(showAnswer ? null : entry.result)}>
            {showAnswer ? 'Hide suggested answer' : 'Show suggested answer'}
          </button>
          {showAnswer && (
            <div data-testid="bookmark-question-answer">
              <p>{entry.result.suggestedAnswer}</p>
              {entry.result.supportingQuote && (
                <blockquote>
                  “{entry.result.supportingQuote}”{' '}
                  <small>{entry.result.quoteVerified ? 'From the transcript' : 'Not found word-for-word in the transcript'}</small>
                </blockquote>
              )}
            </div>
          )}
          <p><small>AI-generated from the transcript ({entry.result.model}{entry.result.cached ? ', cached' : ''}). Check it against the lecture.</small></p>
        </>
      )}
    </div>
  );
}
