import _ from 'lodash';

export function shortTitle(title: string, max = 60): string {
  return _.truncate(title, { length: max, separator: ' ' });
}

export function readingMinutes(wordCount: number): number {
  return Math.max(1, Math.round(wordCount / 200));
}
