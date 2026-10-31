/**
 * Cal.com Integration
 *
 * Week 3 · YOUR TASK. Prove a booking works with STATIC test data before you
 * wire the agent to it — cohort 3 lost an hour to a v1-vs-v2 API mismatch that
 * had nothing to do with the LLM.
 *
 * Provides appointment scheduling via Cal.com API v2.
 * This is the "action" part of the human-in-the-loop pattern.
 *
 * Setup:
 * 1. Create account at https://cal.com
 * 2. Create an event type (e.g., "Patient Appointment")
 * 3. Get API key from Settings -> Developer -> API Keys (it starts with cal_)
 * 4. Get the numeric event type ID. The current Cal UI ("Links") shows a link
 *    uid in the URL, not the number, so read it from the API instead:
 *      curl https://api.cal.com/v2/event-types \
 *        -H "Authorization: Bearer $CAL_API_KEY" \
 *        -H "cal-api-version: 2024-06-14"
 *    -> data[].id is what CAL_EVENT_TYPE_ID wants
 * 5. Add to .env: CAL_API_KEY, CAL_EVENT_TYPE_ID, CAL_TIME_ZONE
 *
 * v2 notes (the v1/v2 split is the trap):
 *   - URL is https://api.cal.com/v2/bookings, NOT /v1/bookings
 *   - the key goes in `Authorization: Bearer cal_...`, NOT `?apiKey=`
 *   - `cal-api-version` is REQUIRED; omit it and Cal silently serves an older
 *     version of the endpoint with a different body shape
 *   - `start` must be UTC, but the UI sends local wall-clock time — see toUtcIso
 *   - v2 requires attendee.name + attendee.timeZone; email and phone are optional
 *
 * Docs: https://cal.com/docs/api-reference/v2/bookings/create-a-booking
 */

import { toE164 } from './contact';

const CAL_API_BASE = 'https://api.cal.com/v2';

// Pinned on purpose: Cal changes the endpoint shape behind this header.
// Bump it deliberately, then re-run the static curl.
const CAL_API_VERSION = '2026-02-25';

// The UI sends "YYYY-MM-DDTHH:MM" with no offset, so every booking needs a
// zone to be interpreted in. Defaults to the clinic's, not the server's.
const DEFAULT_TIME_ZONE = process.env.CAL_TIME_ZONE || 'America/Los_Angeles';

// The value shipped in .env.example. If it is still there, nobody configured a
// real event type and every booking would 400 — fail loudly instead.
const PLACEHOLDER_EVENT_TYPE_ID = '123456';

export interface ScheduleRequest {
  patientName: string;
  dateTime: string; // ISO 8601. Local wall-clock ("2026-11-02T13:15") or UTC
  timeZone?: string; // IANA zone for wall-clock input; falls back to CAL_TIME_ZONE
  patientEmail?: string;
  patientPhone?: string; // used when no email is known — see the attendee below
  notes?: string | null;
}

export interface ScheduleResult {
  success: boolean;
  bookingId?: string;
  bookingUrl?: string;
  error?: string;
}

/**
 * Check if Cal.com is configured. A placeholder event type ID counts as
 * "not configured" — it is the difference between a confusing 400 from Cal and
 * an actionable message.
 */
export function isCalConfigured(): boolean {
  const eventTypeId = process.env.CAL_EVENT_TYPE_ID;
  return Boolean(
    process.env.CAL_API_KEY &&
      eventTypeId &&
      /^\d+$/.test(eventTypeId) &&
      eventTypeId !== PLACEHOLDER_EVENT_TYPE_ID
  );
}

/**
 * Offset of `timeZone` from UTC, in ms, at the given instant.
 * Used by toUtcIso — the platform has no built-in "this wall clock, in that
 * zone" conversion.
 */
function zoneOffsetMs(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);

  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour') % 24, // some ICU builds render midnight as 24
    get('minute'),
    get('second')
  );

  return asUtc - instant.getTime();
}

/**
 * "2026-11-02T13:15" in "America/Los_Angeles" -> "2026-11-02T21:15:00.000Z".
 *
 * A string that already carries an offset or Z is taken as-is. Otherwise the
 * wall clock is read *as if* it were UTC, then shifted by the zone's offset.
 * Two passes because the first offset is measured at the wrong instant; the
 * second is correct except within the hour a DST transition skips over.
 */
export function toUtcIso(wallClock: string, timeZone: string): string {
  if (/([zZ]|[+-]\d{2}:?\d{2})$/.test(wallClock)) {
    return new Date(wallClock).toISOString();
  }

  const naive = new Date(`${wallClock}Z`);
  if (Number.isNaN(naive.getTime())) {
    throw new Error(`Unparseable datetime: "${wallClock}"`);
  }

  const firstPass = new Date(naive.getTime() - zoneOffsetMs(naive, timeZone));
  const secondPass = new Date(naive.getTime() - zoneOffsetMs(firstPass, timeZone));

  return secondPass.toISOString();
}

/** Cal returns `{ error: { code, message } }` or `{ error: "..." }`. */
function calErrorMessage(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined;

  const error = (body as { error?: unknown }).error;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }

  return undefined;
}

/**
 * Schedule an appointment via Cal.com API v2.
 *
 * Static-data check before wiring the agent:
 *
 *   curl -X POST https://api.cal.com/v2/bookings \
 *     -H "Authorization: Bearer $CAL_API_KEY" \
 *     -H "cal-api-version: 2026-02-25" \
 *     -H "Content-Type: application/json" \
 *     -d '{"start":"2026-11-02T21:15:00Z","eventTypeId":<ID>,
 *          "attendee":{"name":"Test Patient","timeZone":"America/Los_Angeles",
 *          "email":"test@example.com"}}'
 */
export async function scheduleAppointment(
  request: ScheduleRequest
): Promise<ScheduleResult> {
  if (!isCalConfigured()) {
    return {
      success: false,
      error:
        'Cal.com is not configured. Set CAL_API_KEY and a real CAL_EVENT_TYPE_ID (123456 is the placeholder).',
    };
  }

  const timeZone = request.timeZone || DEFAULT_TIME_ZONE;
  // Email if the conversation supplied one (or CAL_ATTENDEE_EMAIL is set as an
  // override), otherwise the phone on record: Cal v2 accepts either.
  const email = request.patientEmail || process.env.CAL_ATTENDEE_EMAIL;
  const phoneNumber = request.patientPhone ? toE164(request.patientPhone) : undefined;

  let start: string;
  try {
    start = toUtcIso(request.dateTime, timeZone);
  } catch {
    return {
      success: false,
      error: `Could not read "${request.dateTime}" as a time in ${timeZone}. Expected YYYY-MM-DDTHH:MM.`,
    };
  }

  try {
    const response = await fetch(`${CAL_API_BASE}/bookings`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.CAL_API_KEY}`,
        'cal-api-version': CAL_API_VERSION,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        start,
        eventTypeId: Number(process.env.CAL_EVENT_TYPE_ID),
        attendee: {
          name: request.patientName,
          timeZone,
          ...(email && { email }),
          // Patients here have a phone but no email, so this is the fallback:
          // Cal accepts either, and only requires a phone when the event type
          // has an SMS workflow.
          ...(phoneNumber && { phoneNumber }),
        },
        // Metadata values are capped at 500 chars by Cal.
        ...(request.notes && { metadata: { notes: request.notes.slice(0, 500) } }),
      }),
    });

    const body = await response.json().catch(() => null);

    if (!response.ok || (body as { status?: string } | null)?.status === 'error') {
      const message =
        calErrorMessage(body) ??
        `Cal.com rejected the booking (HTTP ${response.status}).`;

      // The one rejection worth translating: this dataset has no patient
      // emails, so an event type that demands one fails here. Say why.
      if (/email/i.test(message) && !email) {
        return {
          success: false,
          error:
            'Cal.com requires an attendee email for this event type, but the patient record has none. Add an email in the chat or set CAL_ATTENDEE_EMAIL.',
        };
      }

      return { success: false, error: message };
    }

    const booking = (body as { data?: Record<string, unknown> } | null)?.data ?? {};

    // v2 identifies a booking by uid (id is the numeric internal key). There is
    // no bookingUrl in the response — the public page is /booking/<uid>.
    const uid = typeof booking.uid === 'string' ? booking.uid : undefined;

    return {
      success: true,
      bookingId: uid ?? (booking.id != null ? String(booking.id) : undefined),
      ...(uid && { bookingUrl: `https://cal.com/booking/${uid}` }),
    };
  } catch (error) {
    return {
      success: false,
      error:
        error instanceof Error
          ? `Could not reach Cal.com: ${error.message}`
          : 'Could not reach Cal.com.',
    };
  }
}

/**
 * Cancel an appointment
 *
 * TODO (Extension): Implement cancellation
 *   POST https://api.cal.com/v2/bookings/{uid}/cancel
 *   headers: Authorization: Bearer …, cal-api-version: 2026-02-25
 */
export async function cancelAppointment(bookingId: string): Promise<ScheduleResult> {
  // TODO: Implement cancellation via Cal.com API
  return {
    success: false,
    error: 'Not implemented',
  };
}

/**
 * Reschedule an appointment
 *
 * TODO (Extension): Implement rescheduling
 *   POST https://api.cal.com/v2/bookings/{uid}/reschedule
 *   headers: Authorization: Bearer …, cal-api-version: 2026-02-25
 */
export async function rescheduleAppointment(
  bookingId: string,
  newDateTime: string
): Promise<ScheduleResult> {
  // TODO: Implement rescheduling via Cal.com API
  return {
    success: false,
    error: 'Not implemented',
  };
}
