/**
 * The command-ledger executed-stage writer (RL-107).
 *
 * The worker is the component that advances a stored command's
 * acknowledgement past `accepted` (spec/api.md: `executed` appears when a
 * composed command handler applies it, never before). This module is that
 * writer over the SAME record repository the API service ingested the
 * command into (`api-commands`), guarded by optimistic concurrency: the
 * executed stage is written only from `executedAt: null` (a CAS on the
 * stored version) so a racing worker cannot double-apply it and a record
 * that already moved on is left untouched (stages never collapse or lie).
 *
 * PA-025 (the live command-execution path): the write now also records the
 * RESOURCE the executor applied — the durable record of what execution
 * created (`resource: {type, id, version?}`), exactly the fact the PA-019
 * command-ledger read projections project from ("a device exists from
 * execution") and the PA-024 battery simulated. The parameter is OPTIONAL
 * and additive: callers that pass no resource keep the exact pre-PA-025
 * behavior (executedAt only), and the idempotent-replay no-op is unchanged
 * — an already-executed command is NEVER rewritten, so the FIRST
 * execution's facts (instant AND resource) always stand.
 */
import { ConflictError, type CanonicalJsonValue, type UtcInstant } from "@roamlink/contracts";
import type { PersistenceReader, UnitOfWorkFactory } from "@roamlink/persistence";
import { COMMAND_REPOSITORY, type StoredCommand } from "@roamlink/api-service";

import type { CommandLedger, CommandResource } from "./delivery.js";

/** The optimistic-concurrency ledger writer over the real persistence. */
export function createCommandLedger(options: {
  readonly persistence: UnitOfWorkFactory & PersistenceReader;
}): CommandLedger {
  return {
    async markExecuted(commandId: string, at: UtcInstant, resource?: CommandResource): Promise<void> {
      const unitOfWork = await options.persistence.begin();
      try {
        const stored = await unitOfWork.records(COMMAND_REPOSITORY).get(commandId);
        if (stored === null) {
          throw new ConflictError(
            "the command obligation names a command that is not in the ledger (failing closed; nothing is invented)",
            { reason: "COMMAND_LEDGER_CORRUPT" },
          );
        }
        const command = stored.value as unknown as StoredCommand;
        if (command.executedAt !== null) {
          // Already executed (idempotent replay of the same stage): a no-op.
          // The first execution's resource stands too — a replaying redelivery
          // can never rewrite what execution recorded.
          await unitOfWork.rollback();
          return;
        }
        const updated: StoredCommand = {
          ...command,
          executedAt: at,
          ...(resource !== undefined ? { resource } : {}),
        };
        await unitOfWork
          .records(COMMAND_REPOSITORY)
          .compareAndSwap(commandId, stored.version, updated as unknown as CanonicalJsonValue);
        await unitOfWork.commit();
      } catch (error) {
        await unitOfWork.rollback();
        throw error;
      }
    },
  };
}
