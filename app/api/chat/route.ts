import { openai } from '@/lib/openai';
import { zodTextFormat } from 'openai/helpers/zod';
import { searchClinicalNotes } from '@/lib/vector-search';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { runSql } from '@/lib/agents/sql';
import { aggregate } from '@/lib/agents/aggregator';
import { findPatientByName } from '@/lib/patients';
import { resolveReferent, usesPronoun } from '@/lib/referent';
import { adjudicateReferent } from '@/lib/referent-llm';
import { emailFrom } from '@/lib/contact';

const ChatRequestSchema = z.object({
	query: z.string().min(1),
	messages: z
		.array(
			z.object({
				role: z.enum(['user', 'assistant']),
				content: z.string(),
			}),
		)
		.default([]),
});

const AppointmentInfoSchema = z.object({
	patientName: z
		.string()
		.min(1)
		.nullable()
		.describe('Patient name, or null if unknown.'),
	patientEmail: z
		.string()
		.regex(/^[\w.+-]+@[\w-]+\.[A-Za-z]{2,}$/)
		.nullish()
		.describe(
			'Attendee email, ONLY if the user typed one in this request or the conversation. Otherwise null. Never invent an address.',
		),
	date: z.iso
		.date()
		.nullable()
		.describe('Appointment date as YYYY-MM-DD, or null if unresolved.'),
	time: z
		.string()
		.regex(/^([01]\d|2[0-3]):[0-5]\d$/)
		.nullable()
		.describe(
			'Appointment time as HH:MM in 24-hour format, or null if unknown. No seconds.',
		),
	reason: z
		.string()
		.nullable()
		.describe('Appointment reason, or null if not provided.'),
	userMessage: z
		.string()
		.min(1)
		.describe(
			'Ask for missing details, or invite the user to confirm when complete.',
		),
});

// enable mutlippe actioms like sql && vector search
const selectorAgentSchema = z.object({
	actions: z
		.array(
			z.enum([
				'sql_search',
				'vector_search',
				'reject',
				'schedule_appointment',
			]),
		)
		.describe(
			`The actions to take. Vector search is preferred. Only sql and vector search can be combined.
			A booking/scheduling request — "schedule", "book", "reschedule", "cancel an appointment" — is ALWAYS schedule_appointment, even when the patient is only referred to by a pronoun or the date is relative. Never reject a scheduling request.
			Reject only what this assistant cannot do: non-medical questions and medical advice.
			`,
		),

	patientResolution: z
		.object({
			status: z
				.enum(['resolved', 'ambiguous', 'unknown'])
				.describe(
					'resolved = one patient is named in the query or in the previous messages. ambiguous = several are named. unknown = the pronoun has no antecedent anywhere.',
				),
			referent: z
				.string()
				.nullable()
				.describe('The referring word used, e.g. "her". Null when the query names the patient.'),
			name: z
				.string()
				.nullable()
				.describe('The resolved FULL patient name, or null. NEVER invent or guess one.'),
			dob: z
				.string()
				.nullable()
				.describe('YYYY-MM-DD when known, else null. Never guess.'),
		})
		.describe(
			'Who the request is about. A pronoun that refers to the patient discussed in the previous messages is a normal patient reference, not a reason to reject.',
		),
});

const fewShotExamples = [
	{
		query: 'What can you tell me about patient John Doe?',
		actions: ['vector_search'],
		patientResolution: {
			status: 'resolved',
			referent: null,
			name: 'John Doe',
			dob: null,
		},
		reason: 'The query is a simple patient lookup, so we can use vector search.',
	},
	// --- SQL only: counts, filters and structured facts. No notes needed. ---
	{
		query: 'How many patients have diabetes?',
		actions: ['sql_search'],
		patientResolution: { status: 'unknown', referent: null, name: null, dob: null },
		reason:
			'A count over structured condition data. The answer is a number, so SQL alone is enough — the notes would only add noise.',
	},
	{
		query: 'Which patients have had a stroke?',
		actions: ['sql_search'],
		patientResolution: { status: 'unknown', referent: null, name: null, dob: null },
		reason:
			'Listing patients by a recorded condition is a structured lookup; vector search is not needed to name them.',
	},
	// --- SQL + notes: filter on structure, then read the narrative. ---
	{
		query: 'Which smokers have notes mentioning shortness of breath?',
		actions: ['sql_search', 'vector_search'],
		patientResolution: { status: 'unknown', referent: null, name: null, dob: null },
		reason:
			'Two different questions in one: "smokers" is a structured filter (SQL), "notes mentioning shortness of breath" is free text (vector). Use both.',
	},
	{
		query: 'For patients with hypertension, what do the notes say about diet and exercise?',
		actions: ['sql_search', 'vector_search'],
		patientResolution: { status: 'unknown', referent: null, name: null, dob: null },
		reason:
			'The cohort comes from structured data (hypertension) and the answer comes from the notes, so sql and vector search are combined.',
	},
	{
		query: 'What is the capital of Germany',
		actions: ['reject'],
		patientResolution: { status: 'unknown', referent: null, name: null, dob: null },
		reason: 'Not a medical question.',
	},
	{
		query: 'Give me medical advice',
		actions: ['reject'],
		patientResolution: { status: 'unknown', referent: null, name: null, dob: null },
		reason: 'We NEVER give medical advice.',
	},
	{
		query: 'Schedule an appointment for patient John Doe on October 25th, 2026 at 10:00 AM',
		actions: ['schedule_appointment'],
		patientResolution: {
			status: 'resolved',
			referent: null,
			name: 'John Doe',
			dob: null,
		},
		reason:
			'The query is a simple appointment scheduling request, so we can use the schedule_appointment action.',
	},
	{
		query: 'lets schedule a meeting with her for monday at 1:15 pm pst',
		actions: ['schedule_appointment'],
		patientResolution: {
			status: 'resolved',
			referent: 'her',
			name: 'Cassie Heidenreich',
			dob: '1936-12-23',
		},
		reason:
			'Scheduling request using a pronoun. The previous messages name exactly ONE patient, so the referent is definitive: schedule for that patient. A pronoun is never a reason to reject.',
	},
	{
		query: 'book her in for friday at 3pm',
		actions: ['schedule_appointment'],
		patientResolution: {
			status: 'ambiguous',
			referent: 'her',
			name: null,
			dob: null,
		},
		reason:
			'Scheduling request using a pronoun, but the previous messages name SEVERAL patients. Do not choose one: status ambiguous, name null, and the appointment step asks.',
	},
	{
		query: 'schedule an appointment with her tomorrow',
		actions: ['schedule_appointment'],
		patientResolution: {
			status: 'unknown',
			referent: 'her',
			name: null,
			dob: null,
		},
		reason:
			'Pronoun with no patient named anywhere in the conversation. Status unknown, name null: ask which patient. Never invent one.',
	},
	{
		query: 'What medications is she on?',
		actions: ['vector_search'],
		patientResolution: {
			status: 'resolved',
			referent: 'she',
			name: 'Cassie Heidenreich',
			dob: '1936-12-23',
		},
		reason:
			'Pronouns are normal references to the patient from the previous messages, so resolve them from history.',
	},
];

/**
 * The chat pipeline — Week 3. This route IS the orchestrator:
 *
 * Week 3 · assignment: docs/CHALLENGE-TOOL-CALLING.md
 *
 *   1. accept the message + history   (done — parsed below)
 *   2. the selector decides which stores to hit      (lib/agents/selector.ts)
 *   3. call 0, 1, or 2 specialists, in parallel      (lib/agents/sql.ts, rag.ts)
 *   4. the aggregator streams the answer back        (lib/agents/aggregator.ts)
 *
 * Returns JSON: { message, schedulingAction? }. The optional action opens the calendar.
 */
export async function POST(request: Request) {
	try {
		const { query, messages } = ChatRequestSchema.parse(
			await request.json(),
		);
		// selector
		// sql searh vector search OR reject
		const response = await openai.responses.parse({
			model: 'gpt-6-luna',
			input: [
				{
					role: 'system',
					content: `We are a medical facility. Staff ask us to look up patient information and to book appointments.
						Choose the retrieval paths, and say who the request is about.
						Scheduling: any request to book, schedule, reschedule or cancel an appointment is schedule_appointment — never reject it, even when the patient is a pronoun ("her", "him", "that patient") or the date is relative ("Monday", "tomorrow").
						Pronouns refer to the patient discussed in the previous messages: if exactly one patient is named there, that is the referent; if several are named, the status is ambiguous; if none are, it is unknown. Never invent a patient.
						Reject only what we cannot do: non-medical questions, and requests for medical advice.`,
				},
				{
					role: 'user',
					content: `
					query: ${query}
					previous messages: ${JSON.stringify(messages.slice(-5))}
					Example responses: ${JSON.stringify(fewShotExamples)}
					`, // more context
				},
			],
			text: {
				format: zodTextFormat(selectorAgentSchema, 'selector_agent'),
			},
		});

		// if rejected then retrn the rejection reason
		if (response.output_parsed?.actions.includes('reject')) {
			return NextResponse.json({
				message: "I'm sorry, I can't help with that.",
			});
		}

		if (response.output_parsed?.actions.includes('schedule_appointment')) {
			// Who is this about? A pronoun can point many turns back — further
			// than the model can see, since it only gets the last 5 messages —
			// so the referent is walked out in code before we ask the model
			// anything. Ambiguous or unknown means we ask instead of guessing.
			const resolution = await resolveReferent({
				history: messages,
				query,
				lookup: findPatientByName,
				adjudicate: adjudicateReferent,
			});

			if (usesPronoun(query) && resolution.status !== 'resolved') {
				return NextResponse.json({
					message:
						resolution.status === 'ambiguous'
							? `Which patient did you mean — ${resolution.candidates.join(' or ')}?`
							: 'Which patient would you like to schedule?',
					schedulingAction: null,
				});
			}

			// How the referent was found matters when a booking looks wrong:
			// exact/stem = code, adjudicated/extracted = the model proposed it.
			console.log('[referent]', JSON.stringify(resolution));

			const resolvedPatient =
				resolution.status === 'resolved' ? resolution.patient : null;

			// extract the patient name and date from the query OR ask them for the information
			const response = await openai.responses.parse({
				model: 'gpt-6-luna',
				input: [
					{
						role: 'system',
						content: `
							Extract the patient name, date, time, and reason to schedule an appointment.
							Today is ${new Date().toISOString().split('T')[0]}. Resolve relative dates such as Monday or tomorrow using today and the conversation.
							Dates must be YYYY-MM-DD and times HH:MM (24-hour, no seconds).
							Use null for missing or ambiguous fields, never placeholders such as "Not provided".
							Ask for missing patient name, date, or time in userMessage. Reason is optional.
							If the user typed an attendee email, copy it verbatim into patientEmail; otherwise null. Never invent an address.
							${resolvedPatient ? `The patient has already been resolved from the conversation: ${resolvedPatient.name}. Use exactly that name.` : 'The patient could not be resolved from the conversation: do not guess a name.'}
							DO NOT MAKE UP INFORMATION. ONLY USE THE INFORMATION PROVIDED.
							`,
					},
					{
						role: 'user',
						content: `
						Query: ${query}
						Previous messages: ${JSON.stringify(messages.slice(-5))}
						`,
					},
				],
				text: {
					format: zodTextFormat(
						AppointmentInfoSchema,
						'appointment_info',
					),
				},
			});

			const { patientName, patientEmail, date, time, reason, userMessage } =
				AppointmentInfoSchema.parse(response.output_parsed);

			// Identity comes from the resolver, not the model: if code decided
			// who "her" is, that answer wins over the extracted string.
			const finalName = resolvedPatient?.name ?? patientName;

			// A typed email is more reliable than an extracted one, and the
			// record itself has none (the Patient table has a phone, no email).
			const email = emailFrom(query, messages) ?? patientEmail ?? null;

			// Cal takes an email or a phone; with no email, the phone on record
			// is the fallback contact for the attendee.
			const [patient] = finalName ? await findPatientByName(finalName) : [];
			const phone = patient?.phone ?? null;

			return NextResponse.json({
				message: userMessage,
				schedulingAction:
					finalName && date && time
						? {
								patientName: finalName,
								date,
								time,
								reason,
								patientEmail: email,
								patientPhone: phone,
							}
						: null,
			});
		}

		// do we have both actions?
		if (
			response.output_parsed?.actions.includes('sql_search') &&
			response.output_parsed?.actions.includes('vector_search')
		) {
			const [sqlSummary, vectorSummary] = await Promise.all([
				runSql(query, messages),
				searchClinicalNotes(query),
			]);

			console.log('sqlSummary', sqlSummary);
			console.log('vectorSummary', vectorSummary);

			const summary = await aggregate(
				// you summarize the results
				query,
				messages,
				`
				SQL Summary: ${sqlSummary}\n\n
				Vector Summary: ${vectorSummary}
				`,
			);

			return NextResponse.json({
				message: summary,
			});
		}
		// if vector search then run the vector search
		if (response.output_parsed?.actions.includes('vector_search')) {
			const summary = await aggregate(
				query,
				messages,
				`
				Vector Summary: ${await searchClinicalNotes(query)}
				`,
			);
			return NextResponse.json({ message: summary });
		}

		if (response.output_parsed?.actions.includes('sql_search')) {
			const summary = await aggregate(
				query,
				messages,
				`
				SQL Summary: ${await runSql(query, messages)}
				`,
			);
			return NextResponse.json({ message: summary });
		}
	} catch (error) {
		if (error instanceof z.ZodError) {
			return NextResponse.json({ error: error.message }, { status: 400 });
		}
		console.error('Chat error:', error);
		return NextResponse.json(
			{
				error:
					error instanceof Error
						? error.message
						: 'Internal server error',
			},
			{ status: 500 },
		);
	}
}
