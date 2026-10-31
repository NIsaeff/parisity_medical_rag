import assert from 'node:assert/strict';
import { beforeEach, expect, it, vi } from 'vitest';

const { parse } = vi.hoisted(() => ({ parse: vi.fn() }));
vi.mock('@/lib/openai', () => ({ openai: { responses: { parse } } }));
vi.mock('@/lib/vector-search', () => ({ searchClinicalNotes: vi.fn() }));
vi.mock('@/lib/agents/sql', () => ({ runSql: vi.fn() }));
vi.mock('@/lib/agents/aggregator', () => ({ aggregate: vi.fn() }));
vi.mock('@/lib/patients', () => ({
	findPatientByName: vi.fn(async (term: string) => {
		const known = [
			{ firstName: 'Cassie', lastName: 'Heidenreich', birthDate: new Date('1936-12-23'), phone: '555-100-2000' },
			{ firstName: 'Abe', lastName: 'Frami', birthDate: new Date('1950-04-02'), phone: '555-300-4000' },
			{ firstName: 'Brady', lastName: 'Hickle', birthDate: new Date('1934-08-14'), phone: '555-428-8876' },
			{ firstName: 'Bret', lastName: 'Collier', birthDate: new Date('1970-01-01'), phone: '555-428-8876' },
		];
		return known.filter((p) =>
			`${p.firstName} ${p.lastName}`.toLowerCase().includes(term.toLowerCase()),
		);
	}),
}));
// Keep the tests offline: the adjudicator is the only extra LLM call, and it
// is mocked to decline so the deterministic paths are what get exercised.
vi.mock('@/lib/referent-llm', () => ({ adjudicateReferent: vi.fn(async () => ({ name: null })) }));
import { POST } from './route';

const appointment = {
	patientName: 'Bret Collier', date: '2026-10-26', time: '09:00', reason: null,
	patientEmail: null,
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
		schedulingAction: {
			patientName: appointment.patientName,
			date: appointment.date,
			time: appointment.time,
			reason: null,
			// No email typed, and the mock patient rows carry a phone.
			patientEmail: null,
			patientPhone: '555-428-8876',
		},
	});
});

it('carries a patient email typed in the chat through to the booking', async () => {
	parse.mockResolvedValueOnce({ output_parsed: { actions: ['schedule_appointment'] } });
	parse.mockResolvedValueOnce({ output_parsed: appointment });
	const response = await POST(new Request('http://localhost/api/chat', {
		method: 'POST',
		body: JSON.stringify({
			query: 'Schedule Bret Collier on Monday, use bob@example.com',
		}),
	}));
	assert(response);

	const body = await response.json();
	expect(body.schedulingAction.patientEmail).toBe('bob@example.com');
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

async function scheduleWithPronoun(
	history: { role: 'user' | 'assistant'; content: string }[],
	extracted: Record<string, unknown> = appointment,
) {
	parse.mockResolvedValueOnce({ output_parsed: { actions: ['schedule_appointment'] } });
	parse.mockResolvedValueOnce({ output_parsed: extracted });
	const response = await POST(new Request('http://localhost/api/chat', {
		method: 'POST',
		body: JSON.stringify({ query: 'lets schedule a meeting with her for monday at 1:15 pm', messages: history }),
	}));
	assert(response);
	return response.json();
}

it('resolves a pronoun to the single patient named earlier in the conversation', async () => {
	const body = await scheduleWithPronoun([
		{ role: 'assistant', content: 'Cassie Heidenreich (born 1936-12-23) had hypertension.' },
		{ role: 'user', content: 'how is that patient doing?' },
	]);

	// The extraction step echoed the pronoun; the resolver's name wins.
	expect(body.schedulingAction).toMatchObject({ patientName: 'Cassie Heidenreich' });
});

it('asks which patient when the conversation names several', async () => {
	const body = await scheduleWithPronoun([
		{ role: 'assistant', content: 'Abe Frami and Cassie Heidenreich both have hypertension.' },
	]);

	expect(body).toEqual({
		message: 'Which patient did you mean — Abe Frami or Cassie Heidenreich?',
		schedulingAction: null,
	});
});

it('asks for a patient when the pronoun has no antecedent', async () => {
	const body = await scheduleWithPronoun([
		{ role: 'user', content: 'how many patients have hypertension?' },
		{ role: 'assistant', content: 'Twelve patients have hypertension.' },
	]);

	expect(body).toEqual({
		message: 'Which patient would you like to schedule?',
		schedulingAction: null,
	});
});

it('resolves a Synthea note name ("Brady998") to the real patient row', async () => {
	const body = await scheduleWithPronoun([
		{ role: 'assistant', content: 'Brady998 is a 61-year-old man with diabetes.' },
	]);

	// The note says Brady998; the patient table says Brady Hickle.
	expect(body.schedulingAction).toMatchObject({ patientName: 'Brady Hickle' });
});
