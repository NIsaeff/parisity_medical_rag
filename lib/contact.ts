/**
 * Contact details for booking: pull an email out of the conversation, and make
 * a phone number safe to show on screen.
 *
 * Patients have a phone but no email in this dataset (`prisma/schema.prisma`),
 * so an email only exists if the user types one. Cal v2 wants an attendee email
 * or phone number, never both being mandatory, which is why the phone is the
 * fallback.
 */

import type { Message } from './agent';

const EMAIL_SHAPE = /[\w.+-]+@[\w-]+\.[A-Za-z]{2,}/;

/**
 * The most recent email in the conversation, or null.
 * The current message wins; then the history is read newest-first, so a
 * follow-up like "use bob@example.com" applies to the booking being discussed.
 */
export function emailFrom(query: string, history: Message[] = []): string | null {
	const haystack = [query, ...[...history].reverse().map((message) => message.content)];

	for (const text of haystack) {
		const match = text.match(EMAIL_SHAPE);
		if (match) return match[0];
	}

	return null;
}

/**
 * "555-428-8876" -> "+15554288876". Cal wants E.164; the data stores
 * Synthea's dashed 555 numbers.
 */
export function toE164(phone: string): string {
	const digits = phone.replace(/\D/g, '');
	return digits.length === 10 ? `+1${digits}` : `+${digits}`;
}

/**
 * Everything except the last four digits — shown on the confirmation card, so
 * a full number does not sit on screen (or in a screenshot) unnecessarily.
 * "555-428-8876" -> "•••-•••-8876"
 */
export function maskPhone(phone: string): string {
	const digits = phone.replace(/\D/g, '');
	if (digits.length < 4) return '••••';
	return `•••-•••-${digits.slice(-4)}`;
}
