export const MUTATION_HEADERS = Object.freeze({
  requestId: "x-roamlink-request-id",
  correlationId: "x-roamlink-correlation-id",
  idempotencyKey: "idempotency-key",
});

export interface MutationRequestOptions {
  readonly idempotencyKey?: string;
  readonly correlationId?: string;
  readonly expectedVersion?: number;
}

export interface ActorContext {
  readonly actorId: string;
  readonly tenantId: string;
}
