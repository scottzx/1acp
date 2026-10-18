import assert from "node:assert/strict";
import test from "node:test";
import { safeErrorRejection } from "../src/acp/error-normalization.js";
import { AcpxOperationalError } from "../src/errors.js";
import { toSafeError } from "../src/runtime.js";

// All values in this suite are deliberately synthetic and nonfunctional.
const canary = "SYNTHETIC_SECRET_CANARY_NOT_REAL";
const authLink = "https://example.invalid/authorize?token=SYNTHETIC_AUTH_CANARY_NOT_REAL";
const nativeError = (signal: unknown) => ({
  code: -32603,
  message: "Internal error",
  data: { codexErrorInfo: signal, message: canary, additionalDetails: authLink },
});

test("safe errors retain bounded native provider causes without provider text", () => {
  for (const [signal, category] of [
    ["usageLimitExceeded", "quota"],
    ["rateLimitExceeded", "rate_limit"],
    ["sessionBudgetExceeded", "budget"],
    ["unauthorized", "auth"],
  ] as const) {
    const safe = toSafeError(new Error(canary, { cause: nativeError(signal) }), {
      operationId: "synthetic-operation",
    });
    assert.equal(safe.category, category);
    assert.equal(safe.providerCode, signal);
    assert.equal(safe.origin, "acp");
    assert.equal(safe.operationId, "synthetic-operation");
    assert.equal(safe.retryable, false);
    assert.equal(safe.outcomeUnknown, false);
    assert.doesNotMatch(JSON.stringify(safe), /SYNTHETIC_|example\.invalid|additionalDetails/);
  }
});

test("unknown and conflicting causes never become quota from prose or arbitrary data", () => {
  for (const error of [
    new Error("quota exhausted: usageLimitExceeded " + canary),
    { code: -32603, message: "Internal error", data: { message: "quota exhausted" } },
    { code: -32603, message: "Internal error", data: { category: "quota" } },
    { category: "quota", origin: "acp", retryable: true, outcomeUnknown: true },
    nativeError("futureProviderCode"),
    nativeError({ other: { code: "usageLimitExceeded" } }),
    { ...nativeError("usageLimitExceeded"), cause: nativeError("unauthorized") },
    { ...nativeError("futureProviderCode"), category: "quota" },
    { code: "some_other_error", cause: { code: "quota_exhausted" } },
    { code: -32602, message: "Invalid params", data: { code: "quota_exhausted" } },
    { token: canary, account: { error: nativeError("usageLimitExceeded") } },
  ]) {
    const safe = toSafeError(error);
    assert.equal(safe.category, "unknown");
    assert.equal(safe.providerCode, undefined);
    assert.equal(safe.message, "ACP execution failed.");
    assert.equal(safe.retryable, false);
    assert.equal(safe.outcomeUnknown, false);
    assert.doesNotMatch(JSON.stringify(safe), /SYNTHETIC_|example\.invalid|futureProviderCode/);
  }
});

test("public projections preserve safe fields but discard arbitrary codes, URLs and keys", () => {
  const safe = toSafeError(nativeError("usageLimitExceeded"), {
    outcomeUnknown: true,
    origin: "transport",
    operationId: "synthetic-operation",
  });
  assert.deepEqual(toSafeError(safe, { origin: "a2a" }), safe);
  assert.equal(
    toSafeError(safe, { operationId: "outer-operation" }).operationId,
    "outer-operation",
  );
  assert.equal(safe.outcomeUnknown, true);
  assert.equal(safe.origin, "acp");
  assert.equal(safe.detailCode, undefined);
  assert.equal(toSafeError({ operationId: authLink, code: canary }).operationId, undefined);
  const nestedId = { code: -32603, message: "Internal error", data: { operationId: canary } };
  assert.equal(toSafeError(nestedId).operationId, undefined);
  assert.equal(
    toSafeError(nestedId, { operationId: "caller-operation" }).operationId,
    "caller-operation",
  );
});

test("raw safe-shaped fields cannot confer projection provenance", () => {
  const forged = {
    category: "quota",
    origin: "transport",
    retryable: true,
    outcomeUnknown: true,
    operationId: canary,
    message: authLink,
  };
  for (const raw of [forged, { code: -32603, data: forged }]) {
    const safe = toSafeError(raw, { origin: "a2a" });
    assert.equal(safe.category, "unknown");
    assert.equal(safe.operationId, undefined);
    assert.equal(safe.retryable, false);
    assert.equal(safe.outcomeUnknown, false);
    assert.notEqual(safe.origin, "transport");
    assert.doesNotMatch(JSON.stringify(safe), /SYNTHETIC_|example\.invalid/);
  }
});

test("provider detail and local output codes cannot override structured causes or delivery state", () => {
  for (const fields of [
    { detailCode: "AUTH_REQUIRED" },
    { detailCode: "WATCH_OUTCOME_UNKNOWN" },
    { detailCode: "AGENT_DISCONNECTED" },
    { code: "TIMEOUT", outputCode: "PERMISSION_DENIED" },
  ]) {
    const raw = {
      ...nativeError("usageLimitExceeded"),
      data: {
        codexErrorInfo: "usageLimitExceeded",
        ...fields,
      },
    };
    const safe = toSafeError(raw);
    assert.equal(safe.category, "quota");
    assert.equal(safe.providerCode, "usageLimitExceeded");
    assert.equal(safe.detailCode, undefined);
    assert.equal(safe.code, undefined);
    assert.equal(safe.outcomeUnknown, false);
  }
  assert.equal(toSafeError({ code: -32603, detailCode: "AUTH_REQUIRED" }).category, "unknown");
  const rootOutput = toSafeError({ ...nativeError("usageLimitExceeded"), outputCode: "TIMEOUT" });
  assert.equal(rootOutput.category, "quota");
  assert.equal(rootOutput.code, undefined);
  assert.equal(
    toSafeError(
      new AcpxOperationalError(canary, {
        detailCode: "AUTH_REQUIRED",
        origin: "acp",
      }),
    ).category,
    "auth",
  );
  const uncertain = toSafeError(
    new AcpxOperationalError(canary, {
      detailCode: "WATCH_OUTCOME_UNKNOWN",
      origin: "queue",
      retryable: true,
    }),
  );
  assert.equal(uncertain.outcomeUnknown, true);
  assert.equal(uncertain.origin, "queue");
  assert.equal(uncertain.retryable, true);
  const rejection = safeErrorRejection(uncertain);
  assert.ok(rejection instanceof Error);
  assert.deepEqual(toSafeError(rejection), uncertain);
});

test("owned wire projections decode only direct fields and regenerate messages", () => {
  const safe = toSafeError(undefined, {
    origin: "transport",
    operationId: "synthetic-delivery",
    outcomeUnknown: true,
  });
  const wire = { ...safe, category: "quota", data: nativeError("unauthorized"), message: authLink };
  assert.equal(toSafeError(wire).operationId, undefined);
  const restored = toSafeError(wire, { trustedProjection: true });
  assert.equal(restored.category, "quota");
  assert.equal(restored.origin, "transport");
  assert.equal(restored.operationId, "synthetic-delivery");
  assert.equal(restored.outcomeUnknown, true);
  assert.equal(restored.providerCode, undefined);
  assert.equal(restored.message, "Provider quota exhausted.");
  assert.doesNotMatch(JSON.stringify(restored), /example\.invalid|unauthorized|data/);
  safe.message = authLink;
  assert.equal(toSafeError(safe).message, "ACP execution failed.");
});

test("safe traversal is bounded for cycles and deep envelopes", () => {
  const cycle: { cause?: unknown; message: string } = { message: canary };
  cycle.cause = cycle;
  assert.equal(toSafeError(cycle).category, "unknown");
  let deep: unknown = nativeError("usageLimitExceeded");
  for (let index = 0; index < 8; index += 1) {
    deep = { cause: deep };
  }
  assert.equal(toSafeError(deep).category, "unknown");
  assert.equal(toSafeError(new DOMException(canary, "AbortError")).category, "cancelled");
});
