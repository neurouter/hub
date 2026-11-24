import { describe, expect, it } from 'vitest';
import { editDistance, suggestQuery, words } from './suggest.js';

describe('did-you-mean suggestions', () => {
  it('splits identifiers into words', () => {
    expect(words('github__create_issue')).toEqual(['github', 'create', 'issue']);
    expect(words('listPullRequests v2')).toEqual(['list', 'pull', 'requests']);
  });

  it('edit distance counts transpositions as one edit and caps early', () => {
    expect(editDistance('isuse', 'issue', 2)).toBe(1);
    expect(editDistance('kitten', 'sitting', 3)).toBe(3);
    expect(editDistance('a', 'abcdef', 2)).toBe(3);
    expect(editDistance('same', 'same', 1)).toBe(0);
  });

  const texts = ['github__create_issue', 'Create an issue in a repository', 'github__list_issues', 'slack__post_message', 'Post a message to a channel', 'calc__add', 'Add numbers'];

  it('corrects misspelled words against the visible tools', () => {
    expect(suggestQuery('crate isue', texts)).toBe('create issue');
    expect(suggestQuery('slak mesage', texts)).toBe('slack message');
    expect(suggestQuery('Github  isseu', texts)).toBe('github issue');
  });

  it('returns null when every word is known, too far off, or there is no vocabulary', () => {
    expect(suggestQuery('create issue', texts)).toBeNull();
    expect(suggestQuery('kubernetes', texts)).toBeNull();
    expect(suggestQuery('crate', [])).toBeNull();
  });

  it('keeps short words and only allows one typo in short words', () => {
    expect(suggestQuery('to chanel', texts)).toBe('to channel');
    expect(suggestQuery('adx', texts)).toBe('add');
    expect(suggestQuery('azz', texts)).toBeNull();
  });
});
