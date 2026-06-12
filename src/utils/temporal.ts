import { Temporal as TemporalPolyfill } from "@js-temporal/polyfill";

const globalRef = globalThis as unknown as { Temporal?: typeof TemporalPolyfill };
if (!globalRef.Temporal) {
  globalRef.Temporal = TemporalPolyfill;
}

export const Temporal = TemporalPolyfill;

export function instantFromUnixSeconds(seconds: number): string {
  return TemporalPolyfill.Instant.fromEpochMilliseconds(seconds * 1000).toString();
}

export function plainDateFromUnixSeconds(seconds: number): string {
  return TemporalPolyfill.Instant.fromEpochMilliseconds(seconds * 1000)
    .toZonedDateTimeISO("UTC")
    .toPlainDate()
    .toString();
}
