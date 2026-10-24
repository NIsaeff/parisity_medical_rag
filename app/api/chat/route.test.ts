import assert from 'node:assert/strict';
import { beforeEach, expect, it, vi } from 'vitest';

const { parse } = vi.hoisted(() => ({ parse: vi.fn() }));
vi.mock('@/lib/openai', () => ({ openai: { responses: { parse } } }));
vi.mock('@/lib/vector-search', () => ({ searchClinicalNotes: vi.fn() }));
vi.mock('@/lib/agents/sql', () => ({ runSql: vi.fn() }));
vi.mock('@/lib/agents/aggregator', () => ({ aggregate: vi.fn() }));
import { POST } from './route';

const appointment = {
	patientName: 'Bret Collier', date: '2026-10-26', time: '09:00', reason: null,
	userMessage: 'Please confirm the appointment.',
};

beforeEach(() => parse.mockReset());

async function schedule(info: Record<keyof typeof appointment, string | null>) {
	parse.mockResolvedValueOnce({ output_parsed: { actions: ['schedule_appointment'] } });
	parse.mockResolvedValueOnce({ output_parsed: info });
	const response = await POST(new Request('http://localhost/api/chat', {
		method: 'POST', body: JSON.stringify({ query: 'Schedule Bret Collier on Monday' }),
	}));
	assert(response);
	return response;
}

it('returns clarification without a calendar when required details are missing', async () => {
	for (const field of ['patientName', 'date', 'time']) {
		const response = await schedule({ ...appointment, [field]: null, userMessage: 'Please clarify.' });
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ message: 'Please clarify.', schedulingAction: null });
	}
});

it('returns a calendar action for complete details without requiring a reason', async () => {
	const response = await schedule(appointment);
	expect(await response.json()).toEqual({
		message: appointment.userMessage,
		schedulingAction: { patientName: appointment.patientName, date: appointment.date, time: appointment.time, reason: null },
	});
});

it('rejects the reported free-form date and times containing seconds', async () => {
	const error = vi.spyOn(console, 'error').mockImplementation(() => {});
	try {
		for (const invalid of [{ date: 'Monday (specific date not provided)' }, { time: '09:00:00' }]) {
			expect((await schedule({ ...appointment, ...invalid })).status).toBe(400);
		}
	} finally {
		error.mockRestore();
	}
});
