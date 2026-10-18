# Safe execution errors

Embedded runtime failures expose a fixed, readable `message` and compatible
optional fields: `category`, `providerCode`, `retryable`, `outcomeUnknown`,
`origin`, and `operationId`. Existing `code` and `detailCode` fields remain
available when recognized. `toSafeError` exports the same projection for hosts.

Categories are `quota`, `rate_limit`, `budget`, `auth`, `cancelled`, `timeout`,
`permission`, and `unknown`. Provider categories require allowlisted structured
signals in bounded error envelopes. Unknown or conflicting signals stay unknown;
prose such as “quota exceeded” does not establish a provider category.

The projection drops provider messages, arbitrary data, authentication links,
account fields, and unknown codes. Supply a caller-owned `operationId` when
projecting a raw error. A complete projected error can retain its existing
identifier; an arbitrary nested provider identifier is discarded.

Host-owned `assertActive` admission callbacks keep their exception identity and
message for in-process callers. Service boundaries project those exceptions again
before transport. This preserves the local authority callback contract without
forwarding raw provider exceptions.

Failure remains a failed execution. A resource category does not enqueue work,
wait for resources, or schedule a retry. `retryable` is a hint for a caller's
policy. `outcomeUnknown` records uncertainty, including a lost response after
prompt submission; it does not establish that the prompt was never executed.
Cancellation keeps the existing cancelled turn status.

The service's summary and live terminal paths and its ACP connection retain safe
fields. A2A failures expose them in task metadata under `1agents.error`. A host
that reduces errors to code and message can lose the optional fields; downstream
projection then reports unknown instead of reconstructing a cause from text.
Historical journal records containing only error code and text cannot recover
all original fields.
