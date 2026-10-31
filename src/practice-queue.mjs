import { sortQuestions } from './question-order.mjs';

export function buildPracticeQueue(questions, { order = 'fixed', unseenOnly = false, completed = {}, random = Math.random } = {}) {
  const queue = sortQuestions(questions).filter((question) => !unseenOnly || !completed[question.id]);
  if (order === 'random') {
    for (let index = queue.length - 1; index > 0; index -= 1) {
      const target = Math.floor(random() * (index + 1));
      [queue[index], queue[target]] = [queue[target], queue[index]];
    }
  }
  return queue;
}
