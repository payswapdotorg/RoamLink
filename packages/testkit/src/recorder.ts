/**
 * In-memory event/command recorders for tests (RL-040 platform scaffolding).
 *
 * The generic {@link Recorder} captures arbitrary events; the specialized
 * {@link CommandEnvelopeRecorder} captures Wave-0 command envelopes and
 * supports the queries idempotency/retry tests need (RL-LOCK-014): counting
 * attempts per idempotency key, grouping by correlation id, finding by
 * command id. Stored envelopes are frozen plain copies, so later mutation of
 * the source object cannot rewrite history.
 */
import {
  CommandEnvelope,
  type CommandEnvelopePlain,
  type CommandId,
  type CorrelationId,
  type IdempotencyKey,
} from "@roamlink/contracts";

/** Generic in-memory event recorder. */
export class Recorder<TEvent> {
  #events: TEvent[] = [];

  /** Records a single event. */
  record(event: TEvent): void {
    this.#events.push(event);
  }

  /** Records many events in order. */
  recordAll(events: Iterable<TEvent>): void {
    for (const event of events) {
      this.#events.push(event);
    }
  }

  /** Frozen snapshot of the recorded events, in recording order. */
  events(): readonly TEvent[] {
    return Object.freeze([...this.#events]);
  }

  /** Number of recorded events. */
  size(): number {
    return this.#events.length;
  }

  /** The most recently recorded event, if any. */
  last(): TEvent | undefined {
    return this.#events.length === 0 ? undefined : this.#events[this.#events.length - 1];
  }

  /** Frozen snapshot of the events matching `predicate`, in order. */
  filter(predicate: (event: TEvent) => boolean): readonly TEvent[] {
    return Object.freeze(this.#events.filter(predicate));
  }

  /** Removes all recorded events. */
  clear(): void {
    this.#events = [];
  }
}

function toFrozenPlain(
  envelope: CommandEnvelope | CommandEnvelopePlain,
): CommandEnvelopePlain {
  const plain = envelope instanceof CommandEnvelope ? envelope.toPlain() : { ...envelope };
  return Object.freeze(plain);
}

/**
 * In-memory recorder of Wave-0 command envelopes with idempotency-oriented
 * queries. Records are frozen copies of the envelope's plain form.
 */
export class CommandEnvelopeRecorder {
  #envelopes: CommandEnvelopePlain[] = [];

  /** Records an envelope (class or plain form); stores a frozen plain copy. */
  record(envelope: CommandEnvelope | CommandEnvelopePlain): void {
    this.#envelopes.push(toFrozenPlain(envelope));
  }

  /** Frozen snapshot of all recorded envelopes, in recording order. */
  envelopes(): readonly CommandEnvelopePlain[] {
    return Object.freeze([...this.#envelopes]);
  }

  /** All recorded envelopes with the given command id. */
  byCommandId(commandId: CommandId): readonly CommandEnvelopePlain[] {
    return Object.freeze(this.#envelopes.filter((e) => e.commandId === commandId));
  }

  /** All recorded envelopes with the given correlation id. */
  byCorrelationId(correlationId: CorrelationId): readonly CommandEnvelopePlain[] {
    return Object.freeze(this.#envelopes.filter((e) => e.correlationId === correlationId));
  }

  /** All recorded envelopes with the given idempotency key. */
  byIdempotencyKey(idempotencyKey: IdempotencyKey): readonly CommandEnvelopePlain[] {
    return Object.freeze(this.#envelopes.filter((e) => e.idempotencyKey === idempotencyKey));
  }

  /**
   * Number of recorded attempts carrying the given idempotency key - the
   * duplication signal for RL-LOCK-014 idempotency tests (a correct retry
   * pipeline may re-deliver the envelope; the effect must occur once).
   */
  attemptsByIdempotencyKey(idempotencyKey: IdempotencyKey): number {
    return this.#envelopes.filter((e) => e.idempotencyKey === idempotencyKey).length;
  }

  /** Number of recorded envelopes. */
  size(): number {
    return this.#envelopes.length;
  }

  /** Removes all recorded envelopes. */
  clear(): void {
    this.#envelopes = [];
  }
}
