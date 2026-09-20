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
 */
import { ConflictError, type CanonicalJsonValue, type UtcInstant } from "@roamlink/contracts";
import type { PersistenceReader, UnitOfWorkFactory } from "@roamlink/persistence";
import { COMMAND_REPOSITORY, type StoredCommand } from "@roamlink/api-service";

import type { CommandLedger } from "./delivery.js";

/** The optimistic-concurrency ledger writer over the real persistence. */
export function createCommandLedger(options: {
  readonly persistence: UnitOfWorkFactory & PersistenceReader;
}): CommandLedger {
  return {
    async markExecuted(commandId: string, at: UtcInstant): Promise<void> {
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
          await unitOfWork.rollback();
          return;
        }
        const updated: StoredCommand = { ...command, executedAt: at };
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
