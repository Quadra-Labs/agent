// Non-live regression tests for the Walrus error classifier (Phase 1, Task 2).
//
// Targets the review-blocking defect directly: @mysten/walrus error classes are
// anonymous class expressions that never set `this.name`, so an instance reports
// `.name === "Error"` while `.constructor.name === "BlobNotCertifiedError"`.
// Classifying on `.name` alone threw instead of returning a typed
// `blob_unavailable`. These tests feed REAL SDK error instances (plus synthetic
// mirror cases) through the classifier and assert the resulting `kind`.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  BlobBlockedError,
  BlobNotCertifiedError,
  RetryableWalrusClientError,
} from "@mysten/walrus";

import { classifyWalrusError, errorName } from "../src/errorClassification.js";

// Sanity: the installed SDK really does report the misleading `.name`. If this
// ever changes upstream, these tests still pass (we key on both names), but the
// assertion documents the exact failure mode that motivated the classifier.
test("SDK error instances report name='Error' but a correct constructor.name", () => {
  const e = new BlobNotCertifiedError("blob is not certified");
  assert.equal(e.name, "Error");
  assert.equal(e.constructor.name, "BlobNotCertifiedError");
});

// Case 1 — plain Error with a non-network message -> NOT blob_unavailable.
test("plain Error -> unclassified (not blob_unavailable)", () => {
  const c = classifyWalrusError(new Error("x"));
  assert.equal(c.kind, "unclassified");
  assert.notEqual(c.kind, "blob_unavailable");
});

// Case 2 — real BlobNotCertifiedError (name='Error') -> blob_unavailable.
test("real BlobNotCertifiedError -> blob_unavailable", () => {
  const c = classifyWalrusError(new BlobNotCertifiedError("blob 0x.. is not certified"));
  assert.equal(c.kind, "blob_unavailable");
  assert.equal(c.errorName, "BlobNotCertifiedError");
  assert.match(c.message, /not certified/);
});

// Case 3 — real BlobBlockedError (name='Error') -> blob_unavailable.
test("real BlobBlockedError -> blob_unavailable", () => {
  const c = classifyWalrusError(new BlobBlockedError("blob blocked by quorum"));
  assert.equal(c.kind, "blob_unavailable");
  assert.equal(c.errorName, "BlobBlockedError");
});

// Case 4 — real RetryableWalrusClientError -> network_error.
test("real RetryableWalrusClientError -> network_error", () => {
  const c = classifyWalrusError(new RetryableWalrusClientError("temporary failure"));
  assert.equal(c.kind, "network_error");
  assert.equal(c.errorName, "RetryableWalrusClientError");
});

// Case 5 — real DOMException AbortError -> network_error. The trap: its
// `.constructor.name` is the generic "DOMException" while the kind lives in
// `.name`, which is why `.name` is read structurally rather than via constructor
// name alone. (DOMException's instanceof-Error status varies by Node version, so
// we assert the name shape, not the prototype chain.)
test("DOMException AbortError -> network_error, label prefers AbortError", () => {
  const abort = new DOMException("the operation was aborted", "AbortError");
  assert.equal(abort.constructor.name, "DOMException"); // documents the trap
  assert.equal(abort.name, "AbortError");
  const c = classifyWalrusError(abort);
  assert.equal(c.kind, "network_error");
  assert.equal(c.errorName, "AbortError"); // not the generic "DOMException"
});

// Extra — a synthetic TimeoutError by `.name` -> network_error.
test("error with name='TimeoutError' -> network_error", () => {
  class TimeoutError extends Error {
    constructor(msg: string) {
      super(msg);
      this.name = "TimeoutError";
    }
  }
  const c = classifyWalrusError(new TimeoutError("deadline exceeded"));
  assert.equal(c.kind, "network_error");
});

// Extra — message-only network signal (no telling name) -> network_error.
test("plain Error with a network message -> network_error", () => {
  const c = classifyWalrusError(new Error("fetch failed: ECONNRESET"));
  assert.equal(c.kind, "network_error");
});

// Extra — anonymous-class blob error replicated WITHOUT importing the SDK:
// constructor.name is set, `.name` stays 'Error'. Proves the fix is structural,
// not a hard dependency on the SDK module identity.
test("anonymous-class blob error (name='Error') -> blob_unavailable", () => {
  const Anon = class extends Error {};
  Object.defineProperty(Anon, "name", { value: "BlobNotCertifiedError" });
  const c = classifyWalrusError(new Anon("synthetic"));
  assert.equal(c.kind, "blob_unavailable");
});

// Extra — non-Error throwables never crash the classifier.
test("non-Error throwables are unclassified, not crashes", () => {
  assert.equal(classifyWalrusError("just a string").kind, "unclassified");
  assert.equal(classifyWalrusError(undefined).kind, "unclassified");
  assert.equal(classifyWalrusError(null).kind, "unclassified");
  assert.equal(errorName(undefined), "undefined");
});
