# Client-Side Embedding Architecture Implementation Plan (SUPERSEDED)

> **This plan has been subsumed by the formal Spec Kit feature `014-doctor-healthcheck`.**
> The client-side embedding work described here was folded into the broader
> "Reliability Bundle" (model download / client-side embedding / doctor
> healthcheck) and implemented there.

See the authoritative artifacts instead:

- Spec: [`specs/014-doctor-healthcheck/spec.md`](../../../specs/014-doctor-healthcheck/spec.md)
- Plan: [`specs/014-doctor-healthcheck/plan.md`](../../../specs/014-doctor-healthcheck/plan.md)
- Tasks: [`specs/014-doctor-healthcheck/tasks.md`](../../../specs/014-doctor-healthcheck/tasks.md)

The original goal — remote-mode clients embedding with bge-m3 and sending
vectors over HTTP, so the backend runs no inference — is delivered by User
Story 4 (Client-Side Bulk Embedding) of feature 014, together with the
`GET /capabilities`, `GET /memories/pending`, and `POST /memories/:id/embedding`
endpoints, the `chest-index pending-resync` CLI, and the `extractorPromise`
null-cache fix (memory 5138).
