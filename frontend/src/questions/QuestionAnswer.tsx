import { useId, useState } from 'react';
import type { GeneratedQuestion } from './client';
import type { QuestionInteraction } from './quiz';
import './quiz.css';

export function QuestionAnswer({ question, quiz }: { question: GeneratedQuestion; quiz: QuestionInteraction }) {
  const id = useId();
  const [text, setText] = useState('');
  const [choice, setChoice] = useState<number | null>(null);
  const submitted = !!quiz.answer;
  return <div className="recall-answer" data-testid="recall-answer">
    <form onSubmit={(event) => { event.preventDefault(); if (quiz.format === 'typed') quiz.submitTyped(text); else if (choice !== null) quiz.submitChoice(choice); }}>
      {quiz.format === 'typed' ? <label htmlFor={id}>Your answer
        <textarea id={id} rows={3} maxLength={2000} value={submitted ? String(quiz.answer!.response) : text} disabled={submitted} onChange={(event) => setText(event.target.value)} />
        {!submitted && <small>{text.length}/2000 characters. Your answer stays in this browser.</small>}
      </label> : <fieldset disabled={submitted}>
        <legend>Choose one answer</legend>
        <div className="recall-answer__choices">
          {quiz.order.map((index, position) => <label key={index} className={`recall-answer__choice recall-answer__choice--${position}`}>
            <input type="radio" name={id} value={index} checked={(submitted ? quiz.answer!.response : choice) === index} onChange={() => setChoice(index)} />
            <span><strong>{String.fromCharCode(65 + position)}.</strong> {question.choices![index]}</span>
            {submitted && index === question.correctChoiceIndex && <strong>Correct answer</strong>}
          </label>)}
        </div>
      </fieldset>}
      {!submitted && <button type="submit" disabled={quiz.format === 'typed' ? !text.trim() : choice === null}>
        {quiz.format === 'typed' ? 'Submit and compare' : 'Submit answer'}
      </button>}
    </form>
    {submitted && <div data-testid="recall-answer-feedback" role="status">
      {quiz.format === 'multiple_choice' && <strong>{quiz.answer!.correct ? 'Correct' : 'Not quite'}</strong>}
      <p><strong>Suggested answer:</strong> {question.suggestedAnswer}</p>
      {question.supportingQuote && <blockquote>“{question.supportingQuote}” <small>From the transcript</small></blockquote>}
      {quiz.format === 'typed' && (quiz.answer!.correct === null ? <div>
        <p>Compare the meaning with your answer, then self-check. Your text stays in this browser.</p>
        <button type="button" onClick={() => quiz.selfCheck(true)}>I got it right</button>{' '}
        <button type="button" onClick={() => quiz.selfCheck(false)}>I need to review</button>
      </div> : <p>{quiz.answer!.correct ? 'Self-checked: correct.' : 'Self-checked: needs review.'}</p>)}
    </div>}
  </div>;
}
