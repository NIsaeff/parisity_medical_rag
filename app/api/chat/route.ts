import { openai } from '@/lib/openai';
import { zodTextFormat } from 'openai/helpers/zod';
import { searchClinicalNotes } from '@/lib/vector-search';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';

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

const selectorAgentSchema = z.object({
	action: z
		.enum(['sql_search', 'vector_search', 'reject'])
		.describe(
			'The action to take. Vector search is preferred, but if the query is too complex, reject it.',
		),
	reason: z.string().min(5).describe('The reason you chose this action.'),
	rejectionReason: z
		.string()
		.min(1)
		.describe('The reason you rejected the query.'),
	personalInfo: z
		.object({
			name: z.string().min(1).describe('The FULL name of the patient.'),
			dob: z
				.string()
				.min(1)
				.describe(
					'The date of birth of the patient. In this format: YYYY-MM-DD',
				),
		})
		.optional()
		.nullable(),
});

const PRISMA_SCHEMA = `
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
}

enum Role {
  DOCTOR
  STAFF
}

model User {
  id           String   @id @default(uuid())
  email        String   @unique
  passwordHash String
  role         Role
  createdAt    DateTime @default(now())

  @@map("users")
}

model Patient {
  id            String    @id
  firstName     String?
  lastName      String?
  gender        String?
  birthDate     DateTime? @db.Date
  deathDate     DateTime? // null = alive (823/1280 Coherent patients have a death date)
  phone         String?
  maritalStatus String?
  race          String?
  ethnicity     String?
  city          String?
  state         String?

  conditions   Condition[]
  observations Observation[]
  medications  Medication[]
  encounters   Encounter[]
  notes        Note[]

  @@index([lastName, firstName])
  @@map("patients")
}

model Condition {
  id             String    @id
  patientId      String
  code           String? // SNOMED code
  display        String // e.g. "Type 2 Diabetes Mellitus"
  clinicalStatus String? // active | resolved | inactive
  onsetDate      DateTime?
  abatementDate  DateTime?

  patient Patient @relation(fields: [patientId], references: [id], onDelete: Cascade)

  @@index([patientId])
  @@index([display])
  @@map("conditions")
}

model Observation {
  id            String    @id
  patientId     String
  code          String? // LOINC code
  display       String // e.g. "Hemoglobin A1c"
  category      String? // laboratory | vital-signs | survey | ...
  valueNumber   Float?
  valueString   String?
  unit          String?
  effectiveDate DateTime?

  patient Patient @relation(fields: [patientId], references: [id], onDelete: Cascade)

  @@index([patientId])
  @@index([code])
  @@index([display])
  @@map("observations")
}

model Medication {
  id         String    @id
  patientId  String
  code       String? // RxNorm code
  display    String // e.g. "Simvastatin 10 MG Oral Tablet"
  status     String? // active | stopped | completed
  authoredOn DateTime?
  dosage     String?

  patient Patient @relation(fields: [patientId], references: [id], onDelete: Cascade)

  @@index([patientId])
  @@index([display])
  @@map("medications")
}

// Clinical notes live here too: Postgres is the system of record for ALL data.
// Pinecone is a DERIVED index (note text + metadata) kept in sync from this table.
model Note {
  id        String    @id // DocumentReference id — also the vector id in Pinecone
  patientId String
  type      String? // e.g. "History and physical note"
  date      DateTime?
  content   String // the full note text (~450 chars avg); the source of truth

  patient Patient @relation(fields: [patientId], references: [id], onDelete: Cascade)

  @@index([patientId])
  @@map("notes")
}

model Encounter {
  id              String    @id
  patientId       String
  classCode       String? // HL7 v3 ActCode: AMB (ambulatory) | EMER (emergency) | IMP (inpatient)
  type            String? // e.g. "Encounter for problem", "General examination of patient"
  status          String? // finished | in-progress | planned | cancelled
  startDate       DateTime?
  endDate         DateTime?
  serviceProvider String? // organization display, if present

  patient Patient @relation(fields: [patientId], references: [id], onDelete: Cascade)

  @@index([patientId])
  @@index([classCode])
  @@map("encounters")
}
`;

const sqlSchema = z.object({
	sql: z.string().describe('A single Postgres SELECT statement.'),
});

const fewShotExamples = [
	{
		query: 'What can you tell me about patient John Doe?',
		action: 'vector_search',
		reason: 'The query is a simple patient lookup, so we can use vector search.',
	},
	{
		query: 'What is the capital of Germanu',
		action: 'rejected',
		reason: 'Not a medical question.',
	},
	{
		query: 'Give me medical advice',
		action: 'rejected',
		reason: 'We NEVER give medical advice.',
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
					content:
						'We are a medical facility. We need help looking up patient info. the query path to take',
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
		if (response.output_parsed?.action === 'reject') {
			return NextResponse.json({
				message: response.output_parsed.rejectionReason,
			});
		}

		if (response.output_parsed?.action === 'sql_search') {
			// janky text-to-sql: whole prisma schema in, sql out, run it, summarize
			// shortcut: relies on the SELECT-only DB role; add a validator in the safety exercise
			const gen = await openai.responses.parse({
				model: 'gpt-6-sol',
				input: [
					{
						role: 'system',
						content: `Write one Postgres SELECT for this Prisma schema. Use the @@map table names (e.g. "patients") and the column names exactly, quoted if camelCase. LIMIT 50.\n${PRISMA_SCHEMA}`,
					},
					{ role: 'user', content: query },
				],
				text: { format: zodTextFormat(sqlSchema, 'sql') },
			});
			const sql = sqlSchema.parse(gen.output_parsed).sql;
			const rows = await prisma.$queryRawUnsafe(sql);

			const summary = await openai.responses.create({
				model: 'gpt-6-sol',
				input: [
					{
						role: 'system',
						content:
							'Summarize these SQL results for a non-medical person. Concise and readable.',
					},
					{
						role: 'user',
						content: `question: ${query}\nsql: ${sql}\nrows: ${JSON.stringify(rows, (_, v) => (typeof v === 'bigint' ? Number(v) : v))}`,
					},
				],
			});

			return NextResponse.json({ message: summary.output_text });
		}

		if (response.output_parsed?.action === 'vector_search') {
			const searchResults = await searchClinicalNotes(query);

			const summary = await openai.responses.create({
				model: 'gpt-6-sol',
				input: [
					{
						role: 'system',
						content:
							'Summarize the following notes. Format names to not have the numbers and make it concise and readable to a non-medical person.',
					},
					{ role: 'user', content: searchResults },
				],
			});

			return NextResponse.json({ message: summary.output_text });
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
