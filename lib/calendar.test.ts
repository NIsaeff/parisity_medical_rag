import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { scheduleAppointment } from './calendar';

const realFetch = global.fetch;
let sent: Record<string, unknown>[] = [];

beforeEach(() => {
	process.env.CAL_API_KEY = 'cal_live_test';
	process.env.CAL_EVENT_TYPE_ID = '7702715';
	delete process.env.CAL_ATTENDEE_EMAIL;

	sent = [];
	global.fetch = vi.fn(async (_url: string, init: RequestInit) => {
		sent.push(JSON.parse(String(init.body)));
		return new Response(
			JSON.stringify({ status: 'success', data: { uid: 'abc123', id: 1 } }),
			{ status: 201, headers: { 'content-type': 'application/json' } },
		);
	}) as unknown as typeof fetch;
});

afterEach(() => {
	global.fetch = realFetch;
	vi.restoreAllMocks();
});

const base = { patientName: 'Brady Hickle', dateTime: '2026-11-02T09:00' };

describe('scheduleAppointment', () => {
	it('sends the phone number as the attendee contact when no email is known', async () => {
		const result = await scheduleAppointment({ ...base, patientPhone: '555-428-8876' });

		expect(result).toMatchObject({ success: true, bookingId: 'abc123' });
		expect(sent.at(-1)?.attendee).toEqual({
			name: 'Brady Hickle',
			timeZone: 'America/Los_Angeles',
			phoneNumber: '+15554288876',
		});
	});

	it('prefers an email and still sends the phone alongside it', async () => {
		await scheduleAppointment({
			...base,
			patientEmail: 'bob@example.com',
			patientPhone: '555-428-8876',
		});

		expect(sent.at(-1)?.attendee).toEqual({
			name: 'Brady Hickle',
			timeZone: 'America/Los_Angeles',
			email: 'bob@example.com',
			phoneNumber: '+15554288876',
		});
	});

	it('sends no contact keys when neither is known', async () => {
		await scheduleAppointment(base);

		expect(sent.at(-1)?.attendee).toEqual({
			name: 'Brady Hickle',
			timeZone: 'America/Los_Angeles',
		});
	});

	it('uses CAL_ATTENDEE_EMAIL as an override for event types that demand one', async () => {
		process.env.CAL_ATTENDEE_EMAIL = 'clinic@example.com';

		await scheduleAppointment({ ...base, patientPhone: '555-428-8876' });

		expect(sent.at(-1)?.attendee).toMatchObject({ email: 'clinic@example.com' });
	});

	it('translates a missing-email rejection into something actionable', async () => {
		global.fetch = vi.fn(async () =>
			new Response(
				JSON.stringify({ error: { message: 'email is required' } }),
				{ status: 400, headers: { 'content-type': 'application/json' } },
			)) as unknown as typeof fetch;

		const result = await scheduleAppointment({ ...base, patientPhone: '555-428-8876' });

		expect(result.success).toBe(false);
		expect(result.error).toMatch(/requires an attendee email/i);
		expect(result.error).toMatch(/CAL_ATTENDEE_EMAIL/);
	});

	it('retries with the phone alone when Cal rejects the email', async () => {
		// What Cal actually says for a reserved domain such as example.com.
		let call = 0;
		global.fetch = vi.fn(async (_url: string, init: RequestInit) => {
			sent.push(JSON.parse(String(init.body)));
			call += 1;
			if (call === 1) {
				return new Response(
					JSON.stringify({ error: { message: 'This email address cannot receive mail. Please use a valid email.' } }),
					{ status: 400, headers: { 'content-type': 'application/json' } },
				);
			}
			return new Response(
				JSON.stringify({ status: 'success', data: { uid: 'abc123', id: 1 } }),
				{ status: 201, headers: { 'content-type': 'application/json' } },
			);
		}) as unknown as typeof fetch;

		const result = await scheduleAppointment({
			...base,
			patientEmail: 'bob@example.com',
			patientPhone: '555-428-8876',
		});

		expect(sent).toHaveLength(2);
		// First attempt offered both contacts; the retry drops the bad address.
		expect(sent[0]?.attendee).toMatchObject({ email: 'bob@example.com', phoneNumber: '+15554288876' });
		expect(sent[1]?.attendee).toEqual({
			name: 'Brady Hickle',
			timeZone: 'America/Los_Angeles',
			phoneNumber: '+15554288876',
		});
		expect(result).toMatchObject({
			success: true,
			bookingId: 'abc123',
			contact: 'phone',
			droppedEmail: 'bob@example.com',
		});
	});

	it('does not retry when there is no phone to fall back to', async () => {
		global.fetch = vi.fn(async (_url: string, init: RequestInit) => {
			sent.push(JSON.parse(String(init.body)));
			return new Response(
				JSON.stringify({ error: { message: 'This email address cannot receive mail.' } }),
				{ status: 400, headers: { 'content-type': 'application/json' } },
			);
		}) as unknown as typeof fetch;

		const result = await scheduleAppointment({ ...base, patientEmail: 'bob@example.com' });

		expect(sent).toHaveLength(1);
		expect(result.success).toBe(false);
		// The provider's wording is attributed, never presented as ours.
		expect(result.error).toBe('Cal.com This email address cannot receive mail.');
	});

	it('does not retry a rejection that has nothing to do with the email', async () => {		global.fetch = vi.fn(async (_url: string, init: RequestInit) => {
			sent.push(JSON.parse(String(init.body)));
			return new Response(
				JSON.stringify({ error: { message: 'User either already has booking at this time or is not available' } }),
				{ status: 409, headers: { 'content-type': 'application/json' } },
			);
		}) as unknown as typeof fetch;

		const result = await scheduleAppointment({
			...base,
			patientEmail: 'bob@example.com',
			patientPhone: '555-428-8876',
		});

		expect(sent).toHaveLength(1);
		expect(result.error).toMatch(/^Cal\.com /);
	});
});

describe('event types that require an email', () => {
	it("translates Cal's field-validation payload into a sentence", async () => {
		global.fetch = vi.fn(async () =>
			new Response(
				JSON.stringify({ error: { message: 'responses - {email}error_required_field, ' } }),
				{ status: 400, headers: { 'content-type': 'application/json' } },
			)) as unknown as typeof fetch;

		const result = await scheduleAppointment({ ...base, patientPhone: '555-428-8876' });

		expect(result.success).toBe(false);
		expect(result.error).toMatch(/requires an attendee email/i);
		expect(result.error).toMatch(/CAL_ATTENDEE_EMAIL/);
	});

	it('explains the requirement when the phone retry is rejected too', async () => {
		let call = 0;
		global.fetch = vi.fn(async (_url: string, init: RequestInit) => {
			sent.push(JSON.parse(String(init.body)));
			call += 1;
			const message =
				call === 1
					? 'This email address cannot receive mail. Please use a valid email.'
					: 'responses - {email}error_required_field, ';
			return new Response(JSON.stringify({ error: { message } }), {
				status: 400,
				headers: { 'content-type': 'application/json' },
			});
		}) as unknown as typeof fetch;

		const result = await scheduleAppointment({
			...base,
			patientEmail: 'bob@example.com',
			patientPhone: '555-428-8876',
		});

		expect(sent).toHaveLength(2);
		expect(result.error).toMatch(/requires an attendee email/i);
	});

	it('books normally when CAL_ATTENDEE_EMAIL satisfies the requirement', async () => {
		process.env.CAL_ATTENDEE_EMAIL = 'clinic@example.org';

		const result = await scheduleAppointment({ ...base, patientPhone: '555-428-8876' });

		expect(result).toMatchObject({ success: true, contact: 'email' });
		expect(sent.at(-1)?.attendee).toEqual({
			name: 'Brady Hickle',
			timeZone: 'America/Los_Angeles',
			email: 'clinic@example.org',
			phoneNumber: '+15554288876',
		});
	});
});

describe('fallback order', () => {
	it('prefers CAL_ATTENDEE_EMAIL over the phone when the typed address is rejected', async () => {
		process.env.CAL_ATTENDEE_EMAIL = 'clinic@example.org';
		sent = [];
		let call = 0;
		global.fetch = vi.fn(async (_url: string, init: RequestInit) => {
			sent.push(JSON.parse(String(init.body)));
			call += 1;
			if (call === 1) {
				return new Response(
					JSON.stringify({ error: { message: 'This email address cannot receive mail.' } }),
					{ status: 400, headers: { 'content-type': 'application/json' } },
				);
			}
			return new Response(
				JSON.stringify({ status: 'success', data: { uid: 'abc123' } }),
				{ status: 201, headers: { 'content-type': 'application/json' } },
			);
		}) as unknown as typeof fetch;

		const result = await scheduleAppointment({
			...base,
			patientEmail: 'bob@example.com',
			patientPhone: '555-428-8876',
		});

		expect(sent).toHaveLength(2);
		expect(sent[1]?.attendee).toMatchObject({ email: 'clinic@example.org', phoneNumber: '+15554288876' });
		expect(result).toMatchObject({ success: true, contact: 'email', droppedEmail: 'bob@example.com' });
	});
});
