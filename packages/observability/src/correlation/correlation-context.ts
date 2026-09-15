/**
 * Correlation-ID context contract (RL-040 platform scaffolding,
 * RL-LOCK-014: every cross-boundary command carries a correlation id).
 *
 * The context PROPAGATES the Wave-0 command envelope's correlationId (plus
 * tenant, command and actor identity) through async call chains. Two
 * dependency-free carriers are provided:
 *
 *  - `createAsyncCorrelationCarrier()` - AsyncLocalStorage-based; the context
 *    flows through `await` boundaries and concurrent runs stay isolated;
 *  - `createManualCorrelationCarrier()` - explicit save/restore for tests and
 *    runtimes without async hooks (no async isolation - documented).
 */
import { AsyncLocalStorage } from "node:async_hooks";
import {
  ValidationError,
  parseActorId,
  parseCommandId,
  parseCorrelationId,
  parseTenantId,
  type ActorId,
  type CommandEnvelope,
  type CommandEnvelopePlain,
  type CommandId,
  type CorrelationId,
  type TenantId,
} from "@roamlink/contracts";

/** The propagated correlation identity (all fields pre-validated Wave-0 types). */
export interface CorrelationContext {
  readonly correlationId: CorrelationId;
  readonly tenantId?: TenantId;
  readonly commandId?: CommandId;
  readonly actorId?: ActorId;
}

/** Input accepted by {@link makeCorrelationContext}. */
export interface CorrelationContextInput {
  readonly correlationId: string;
  readonly tenantId?: string;
  readonly commandId?: string;
  readonly actorId?: string;
}

export function makeCorrelationContext(input: CorrelationContextInput): CorrelationContext {
  if (input === null || typeof input !== "object") {
    throw new ValidationError("CorrelationContext input must be an object", {
      reason: "CORRELATION_CONTEXT_INVALID",
      details: [{ path: "CorrelationContext", issue: "not an object" }],
    });
  }
  const correlationId = parseCorrelationId(input.correlationId);
  return Object.freeze({
    correlationId,
    ...(input.tenantId !== undefined ? { tenantId: parseTenantId(input.tenantId) } : {}),
    ...(input.commandId !== undefined ? { commandId: parseCommandId(input.commandId) } : {}),
    ...(input.actorId !== undefined ? { actorId: parseActorId(input.actorId) } : {}),
  });
}

/**
 * Extracts the correlation context from a Wave-0 command envelope (class or
 * plain form) - the canonical way a command's correlation identity enters
 * the observability plane.
 */
export function correlationContextFromCommandEnvelope(
  envelope: CommandEnvelope | CommandEnvelopePlain,
): CorrelationContext {
  return Object.freeze({
    correlationId: envelope.correlationId,
    tenantId: envelope.tenantId,
    commandId: envelope.commandId,
    actorId: envelope.actorId,
  });
}

/** Port for reading/establishing the current correlation context. */
export interface CorrelationContextCarrier {
  /** The context established by the innermost enclosing `run`, if any. */
  current(): CorrelationContext | undefined;
  /** Establishes `context` for the synchronous+async extent of `fn`. */
  run<T>(context: CorrelationContext, fn: () => T): T;
}

/**
 * AsyncLocalStorage-backed carrier: the context propagates across `await`
 * boundaries and concurrent `run` scopes stay isolated (no cross-talk).
 */
export function createAsyncCorrelationCarrier(): CorrelationContextCarrier {
  const storage = new AsyncLocalStorage<CorrelationContext>();
  return {
    current: () => storage.getStore(),
    run: (context, fn) => storage.run(context, fn),
  };
}

/**
 * Manual save/restore carrier for tests and runtimes without async hooks.
 * NOTE: unlike the async carrier, `run` restores the previous context when
 * the SYNCHRONOUS extent of `fn` ends - awaited continuations that outlive
 * `fn` do not stay attached.
 */
export function createManualCorrelationCarrier(): CorrelationContextCarrier {
  let current: CorrelationContext | undefined;
  return {
    current: () => current,
    run: <T>(context: CorrelationContext, fn: () => T): T => {
      const previous = current;
      current = context;
      try {
        return fn();
      } finally {
        current = previous;
      }
    },
  };
}
