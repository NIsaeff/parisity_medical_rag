import { describe, expect, it } from 'vitest';

import { emailFrom, maskPhone, toE164 } from './contact';
import type { Message } from './agent';

const user = (content: string): Message => ({ role: 'user', content });
const assistant = (content: string): Message => ({ role: 'assistant', content });

describe('emailFrom', () => {
	it('takes an address typed in the current message', () => {
		expect(emailFrom('schedule her for monday, use bob@example.com')).toBe('bob@example.com');
	});

	it('prefers the current message over the history', () => {
		const history = [user('my old address was old@example.com')];

		expect(emailFrom('actually use new@example.com', history)).toBe('new@example.com');
	});

	it('reads the most recent address in the history', () => {
		const history = [
			user('first@example.com'),
			assistant('noted'),
			user('second@example.com'),
		];

		expect(emailFrom('schedule her', history)).toBe('second@example.com');
	});

	it('is null when nobody typed an address', () => {
		expect(emailFrom('schedule him for monday at 9am', [assistant('Brady998 was seen.')])).toBeNull();
	});

	it('does not treat a bare @ or a partial address as an email', () => {
		expect(emailFrom('email me at @ or bob@')).toBeNull();
	});
});

describe('toE164', () => {
	it.each([
		['555-428-8876', '+15554288876'],
		['(555) 428 8876', '+15554288876'],
		['555.428.8876', '+15554288876'],
		['+1 555 428 8876', '+15554288876'],
	])('converts %s', (input, expected) => {
		expect(toE164(input)).toBe(expected);
	});
});

describe('maskPhone', () => {
	it('keeps only the last four digits', () => {
		expect(maskPhone('555-428-8876')).toBe('•••-•••-8876');
	});

	it('degrades safely on a short value', () => {
		expect(maskPhone('123')).toBe('••••');
	});
});
