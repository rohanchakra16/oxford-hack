import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BookmarkQuestion, QuestionProviderControls, useBookmarkQuestions, type BookmarkRange } from '../index';
import type { Sentence } from '../../transcript';

const sentences: Sentence[] = [
  { index: 0, startS: 0, endS: 10, text: 'Voltage drives current through a circuit and resistance limits the flow of charge.', cueIndices: [0] },
  { index: 1, startS: 10, endS: 20, text: 'At a fixed voltage, increasing resistance reduces current because current equals voltage divided by resistance.', cueIndices: [1] },
  { index: 2, startS: 20, endS: 30, text: 'We will take a short break now and return in five minutes with some water.', cueIndices: [2] },
];
const bookmarks: BookmarkRange[] = [
  { bookmarkId: 'b1', videoId: 'v1', suggestedMediaS: 10, evidenceMedia: { startMediaS: 10, endMediaS: 20 } },
  { bookmarkId: 'b2', videoId: 'v1', suggestedMediaS: 20, evidenceMedia: { startMediaS: 20, endMediaS: 30 } },
];

function Fixture() {
  const questions = useBookmarkQuestions({ bookmarks, sentences, videoId: 'v1', enabled: true, backendUrl: window.location.origin });
  return <main>
    <h1>Saved lecture moments</h1>
    <QuestionProviderControls {...questions.controls} />
    {bookmarks.map((bookmark) => <article key={bookmark.bookmarkId} data-testid={`saved-${bookmark.bookmarkId}`}>
      <h2>Saved bookmark {bookmark.bookmarkId}</h2>
      <button disabled={!questions.ready} onClick={() => questions.request(bookmark)}>Test recall {bookmark.bookmarkId}</button>
      <BookmarkQuestion entry={questions.get(bookmark.bookmarkId)} onRetry={() => questions.retry(bookmark)} />
    </article>)}
  </main>;
}

createRoot(document.getElementById('root')!).render(<StrictMode><Fixture /></StrictMode>);
