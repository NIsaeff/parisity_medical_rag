# Homework 3 — Week 3

**Branch:** `cohort_4_homework_3` · based on `cohort_4` (`d043010`) · 8 commits · 56 tests passing

This branch is my Week 3 submission. It runs the medical-records assistant end to end, adds the
few-shot examples the assignment asks for, and adds the pieces I needed to make scheduling
actually work against Cal.com.

---

## The assignment

From the pinned **Week 3 Homework** post in `#cohort-4`:

1. **Run the whole app end to end.** Ask it questions that hit SQL, the notes, and both. Then
   schedule an appointment and make sure it actually shows up in your cal.com calendar. Open
   LangSmith and follow at least one question through every step: selector → SQL/RAG → answer.
2. **Add few-shot examples.** At least 2 per kind of question — SQL, notes/vector, SQL + notes,
   scheduling, off-topic/general — kept in one list.
3. **Video (3–5 min): pitch an AI project.** The problem, the solution, a back-of-the-envelope
   cost, and one risk. Pitched to a manager, no code.

Requirement 3 is a recording, not code — checklist at the bottom.

---

## 1. Run the whole app end to end

Each question below was sent through the chat UI (`http://localhost:3000`) and then verified in
LangSmith, not just read off the screen.

| Path | Question | Answer | What the trace shows |
|---|---|---|---|
| SQL only | *"How many patients have diabetes?"* | **29 patients** | `16:31:50` selector → `{"actions":["sql_search"]}` · `16:31:53` SQL filter `{"conditions":["Diabetes"]}` · `16:31:56` aggregator |
| Notes / vector | *"Summarize the health history of one of the patients"* | patient summary | selector → `vector_search` (embed → Pinecone → rerank) → aggregator |
| SQL + notes | *"Which smokers have notes mentioning shortness of breath?"* | **8 smokers** | `16:32:06` selector → `{"actions":["sql_search","vector_search"]}` · `16:32:09` SQL filter `{"conditions":["Smokes tobacco daily"]}` · `16:32:12` aggregator |
| Scheduling | *"lets schedule him for monday at 9 am pst"* | confirmation card → booked | selector → `schedule_appointment` · referent resolved to *Brady Hickle* · extraction `{"date":"2026-11-02","time":"09:00"}` |

### The booking is real

Verified against the Cal.com API, not just the UI:

```
uid      5RkoXnhAUA8kwzkGAgqvxM
start    2026-11-02T17:00:00.000Z   (= 9:00 AM PST — the UTC conversion is right)
duration 30 min
status   accepted
title    30 min meeting between Nathaniel Isaeff and Brady Hickle
```

### How the trace was read

`wrapOpenAI` in `lib/openai.ts` reports every model call, so a single question appears as several
runs: the selector, the SQL filter extraction, the embeddings call, and the aggregator. I pulled
them programmatically from the LangSmith API (`/runs/query`) and matched each run's
`output_parsed` to the step it belongs to — that is how the table above was built, rather than
trusting the chat transcript.

---

## 2. Few-shot examples

All examples live in one list — `fewShotExamples` in `app/api/chat/route.ts`. Every entry now has
the same shape (`query`, `actions`, `patientResolution`, `reason`).

| Category | Count | Examples |
|---|---|---|
| SQL only | 2 | *"How many patients have diabetes?"* · *"Which patients have had a stroke?"* |
| Notes / vector | 2 | *"What can you tell me about patient John Doe?"* · *"What medications is she on?"* |
| SQL + notes | 2 | *"Which smokers have notes mentioning shortness of breath?"* · *"For patients with hypertension, what do the notes say about diet and exercise?"* |
| Scheduling | 4 | explicit name · pronoun with one antecedent · pronoun with several · pronoun with none |
| Off-topic / general | 2 | *"What is the capital of Germany"* · *"Give me medical advice"* |

The scheduling examples are the interesting ones: they teach three different pronoun outcomes —
`resolved`, `ambiguous`, `unknown` — so the model learns that a pronoun is a normal patient
reference and never, by itself, a reason to reject.

---

## 3. What else is on this branch

The Week 3 lessons run through scheduling, so a few things had to be fixed to make requirement 1
possible at all. Each is its own commit.

**Cal.com API v2** (`lib/calendar.ts`, `d043010`) — the skeleton targeted v1 (`?apiKey=`, `responses`
body). Migrated to `POST /v2/bookings` with `Authorization: Bearer`, the required
`cal-api-version: 2026-02-25` header, and `attendee { name, timeZone, email?, phoneNumber? }`.
The UI sends local wall-clock time, so `toUtcIso` converts to UTC by hand — verified across DST
boundaries (`2026-11-02T13:15` America/Los_Angeles → `21:15Z`).

**Pronoun resolution** (`lib/referent.ts`, `lib/referent-llm.ts`) — *"schedule **him** for monday"*
has to know who "him" is. The selector only ever sees `messages.slice(-5)`, so an antecedent six
turns back is invisible to the model: it has to be code. The resolver walks history backwards and
stops at the first turn that names exactly one patient, returns `ambiguous` when a turn names
several, and `unknown` when the conversation never names anyone. A model call is used only for the
two cases code cannot settle (pick among named candidates, or read a name span out of free text),
and anything it proposes is re-confirmed against the database before it can reach the calendar.

**Synthea name shapes** (`130d25b`) — the notes call patients `"Brady998"` while the `patients`
table stores `Brady Hickle`, so the first version resolved nothing. Candidates now include the
`Name123` shape and are looked up by their alphabetic stem.

**Contact fallback** (`lib/contact.ts`, `1f98c87`) — patients have a phone and **no email** in this
dataset, so bookings initially carried no contact at all. The attendee now gets `phoneNumber`
(E.164) whenever the row has one, and an email only when one exists — typed into the chat, or
`CAL_ATTENDEE_EMAIL` for event types that require one. The confirmation card says which contact
will be used, with the number masked to its last four digits.

**Retry after a rejected email** (`599830e`) — Cal validates that an attendee address can receive
mail, so `bob@example.com` rejected the whole booking. The booking path now falls back typed email
→ `CAL_ATTENDEE_EMAIL` → phone on record, reports which contact won, and prefixes provider errors
with `Cal.com` so their wording is never passed off as ours.

---

## How it was tested

**Unit tests — 56 passing across 6 files** (`npx vitest run`):

| File | Covers |
|---|---|
| `lib/referent.test.ts` | chain-of-pronoun walk-back, ambiguity stop, stem lookup (`Brady998` → `Brady Hickle`), model-proposal rejection, turn budget |
| `lib/calendar.test.ts` | `toUtcIso` incl. DST, attendee composition, retry-after-rejected-email, no-retry cases, field-validation translation |
| `lib/contact.test.ts` | email extraction from query/history, E.164 conversion, phone masking |
| `app/api/chat/route.test.ts` | scheduling clarification vs action, pronoun resolution end to end, Synthea name, phone/email pass-through |
| `app/api/schedule/route.test.ts` | 503 when unconfigured, contact pass-through, confirmation copy |
| `lib/agents/sql.test.ts` | `buildWhere` filters |

`npx tsc --noEmit` is clean.

**Live checks** — the four questions in the table above, the Cal booking confirmed through the
API, and the confirmation card verified for both the no-email case (masked phone warning) and the
with-email case (no warning).

**What the tests do not cover** — the model's own judgement. The selector's choice of actions is
only verified by reading traces, which is exactly why the LangSmith step in requirement 1 matters.

---

## Running it

```bash
yarn install
npm run dev            # http://localhost:3000
```

`.env` needs `DATABASE_URL`, `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `PINECONE_API_KEY`,
`PINECONE_INDEX`, and — for tracing — `LANGSMITH_TRACING=true`, `LANGSMITH_API_KEY`,
`LANGSMITH_PROJECT`.

For scheduling: `CAL_API_KEY` (a `cal_live_…` key), a real `CAL_EVENT_TYPE_ID` (the number from
`GET /v2/event-types`, not the uid in the Cal UI's URL), `CAL_TIME_ZONE`, and — because the demo
event type marks email as required — `CAL_ATTENDEE_EMAIL`.

Try in order: *"How many patients have diabetes?"* (SQL) → *"Summarize the health history of one of
the patients"* (notes) → *"Which smokers have notes mentioning shortness of breath?"* (both) →
*"lets schedule him for monday at 9 am pst"* (scheduling).

---

## Known limitations

- **Combined answers are thin.** The SQL+notes reply was *"8 smokers have notes mentioning shortness
  of breath, according to the SQL summary. Their names are not included in the provided results."*
  Both paths ran, but the SQL leg returns a count, so the aggregator has no names to attribute.
  Fix belongs in `lib/agents/sql.ts` (render sampled names alongside the count), not in a prompt.
- **Phone numbers are fictional.** Every patient phone is a Synthea `555-…` value. Cal accepts it,
  but no SMS is ever delivered — which is why the card says "on record" rather than implying a text.
- **The branch predates Week 4.** `origin/cohort_4` has since moved 5 commits ahead (tool calling,
  evals golden set, Retell confirmation calls). Not merged here on purpose: homework 3 is a Week 3
  assignment and mixing the refactor into it would make both harder to read.
- **Week 4 stubs are untouched.** `lib/evals/llm-judge.ts` and `app/api/chat-graph/route.ts` still
  throw "Not implemented — your turn!". They come from the base repo and belong to the next
  assignment, not this one.

---

## Requirement 3 — video

Not code, still to record. 3–5 minutes:

- [ ] **The problem** — what is slow or manual today
- [ ] **The solution** — RAG, agent, or both; what data; what it does
- [ ] **Cost** — requests/day × ~2–5k tokens × 30 days = monthly cost, vs the time saved
- [ ] **One risk** — wrong answers, private data, or cost blowing up — and how you'd contain it

Pitch it like you're talking to your manager, no code.
