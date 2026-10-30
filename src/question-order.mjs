const natural = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });

export function compareQuestions(a, b) {
  const subject = natural.compare(a.subject || '', b.subject || '');
  if (subject) return subject;

  const category = natural.compare(a.category || '', b.category || '');
  if (category) return category;

  const yearA = Number(a.year) || 0;
  const yearB = Number(b.year) || 0;
  if (yearA !== yearB) return yearB - yearA;

  const numberA = Number(a.number) || 0;
  const numberB = Number(b.number) || 0;
  if (numberA !== numberB) return numberA - numberB;

  const paper = natural.compare(a.paper || '', b.paper || '');
  if (paper) return paper;

  const source = natural.compare(a.path || '', b.path || '');
  return source || natural.compare(a.title || '', b.title || '');
}

export function sortQuestions(questions) {
  return [...questions].sort(compareQuestions);
}
