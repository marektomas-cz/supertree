import { describe, expect, it } from 'vitest';
import { formatGreeting } from './format';

describe('formatGreeting', () => {
  it('formats a greeting for a name', () => {
    expect(formatGreeting('Supertree')).toBe('Hello, Supertree!');
  });
});
