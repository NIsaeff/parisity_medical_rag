import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { scheduleAppointment } from './calendar';

const realFetch = global.fetch;
let sent: Record<string, unknown> | undefined;

beforeEach(() => {
	process.env.CAL_API_KEY = 'cal_live_test';
	process.env.CAL_EVENT_TYPE_ID = '7702715';
	delete process.env.CAL_ATTENDEE_EMAIL;

	sent = undefined;
	global.fetch = vi.fn(async (_url: string, init: RequestInit) => {
		sent = JSON.parse(String(init.body));
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
		expect(sent?.attendee).toEqual({
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

		expect(sent?.attendee).toEqual({
			name: 'Brady Hickle',
			timeZone: 'America/Los_Angeles',
			email: 'bob@example.com',
			phoneNumber: '+15554288876',
		});
	});

	it('sends no contact keys when neither is known', async () => {
		await scheduleAppointment(base);

		expect(sent?.attendee).toEqual({
			name: 'Brady Hickle',
			timeZone: 'America/Los_Angeles',
		});
	});

	it('uses CAL_ATTENDEE_EMAIL as an override for event types that demand one', async () => {
		process.env.CAL_ATTENDEE_EMAIL = 'clinic@example.com';

		await scheduleAppointment({ ...base, patientPhone: '555-428-8876' });

		expect(sent?.attendee).toMatchObject({ email: 'clinic@example.com' });
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
});
