// Start-time / static config failure. A constructor (and a static `start`) is
// the only place config can fail BEFORE any operation, and it cannot return a
// typed result — so it throws. The throw shares the `config_error` discriminator
// with the operation-time result `kind` (PHASE1_PLAN.md gate item 9).
//
// Operation-time config failure (store() without a signer) is a `config_error`
// RESULT, not this throw — see walrusService.store().

export class WalrusConfigError extends Error {
  readonly kind = "config_error";

  constructor(message: string) {
    super(message);
    this.name = "WalrusConfigError";
  }
}
