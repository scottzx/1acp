import assert from "node:assert/strict";
import test from "node:test";
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
    assert.doesNotMatch(JSON.stringify(safe), /SYNTHETIC_|example\.invalid|futureProviderCode/);
  }
});

test("public projections preserve safe fields but discard arbitrary codes, URLs and keys", () => {
  const safe = toSafeError({
    ...nativeError("usageLimitExceeded"),
    retryable: false,
    outcomeUnknown: true,
    origin: "transport",
    operationId: "synthetic-operation",
    detailCode: authLink,
    token: canary,
  });
  assert.deepEqual(toSafeError(safe, { origin: "a2a" }), safe);
  assert.equal(
    toSafeError(safe, { operationId: "outer-operation" }).operationId,
    "outer-operation",
  );
  assert.equal(safe.outcomeUnknown, true);
  assert.equal(safe.origin, "transport");
  assert.equal(safe.detailCode, undefined);
  assert.equal(toSafeError({ operationId: authLink, code: canary }).operationId, undefined);
  const nestedId = { code: -32603, message: "Internal error", data: { operationId: canary } };
  assert.equal(toSafeError(nestedId).operationId, undefined);
  assert.equal(
    toSafeError(nestedId, { operationId: "caller-operation" }).operationId,
    "caller-operation",
  );
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
