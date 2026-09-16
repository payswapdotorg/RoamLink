/**
 * The ExperienceIntentCompiler (RL-012, spec/adcos-integration.md §4).
 *
 * Compiles an ExperienceIntent (the customer's expression of WHAT they want
 * from connectivity) into a technology-neutral ADCOS ConnectivityIntent
 * command, executing the eight §4 stages in order:
 *
 *   1. schema validation          (validate-compilation-input.ts)
 *   2. policy normalization       (policy.ts)
 *   3. hard/soft classification   (policy.ts)
 *   4. privacy/service mapping    (policy.ts)
 *   5. validity-window calc       (policy.ts)
 *   6. canonical serialization    (command.ts)
 *   7. digest generation          (command.ts)
 *   8. command creation          (command.ts)
 *
 * PURE FUNCTION OF ITS INPUTS: no I/O, no ambient clocks, no random, no
 * hidden state. The command instant and the command id are ALWAYS caller
 * arguments (tests inject the testkit clock/generators; services inject
 * their own). Identical inputs produce byte-identical canonical JSON, the
 * same digest and the same derived envelope defaults.
 *
 * TRACEABILITY (§4): every emitted command carries the source
 * ExperienceIntent id + version id + version number, both in the command
 * payload (`sourceIntentId`/`sourceIntentVersionId`/
 * `sourceIntentVersionNumber`) and in the §5 envelope (`intentVersion`).
 *
 * AUTHORITY (RL-LOCK-005/007): the compiler TRANSLATES experience into
 * technology-neutral requirements. It never invents network facts, never
 * selects paths, never mutates ADCOS or domain state; the ADCOS-side v2
 * request mapping belongs to the integration surface (RL-031), which
 * consumes this package's structural output.
 */
import type { CommandEnvelope } from "@roamlink/contracts";
import type {
  ExperienceIntentRecord,
  ExperienceIntentVersionRecord,
} from "@roamlink/domain-experience";

import { serializeDigestAndCreateCommand, type CompiledIntentCommand } from "./command.js";
import { normalizePolicy } from "./policy.js";
import {
  validateCompilationInput,
  type CompileIntentOptions,
  type ValidatedCompilationInput,
} from "./validate-compilation-input.js";

/**
 * The compiler. Stateless by construction: the class exists as the §4-named
 * seam services program against; every compile is independent.
 */
export class ExperienceIntentCompiler {
  /**
   * Compiles the CURRENT version of a draft/active ExperienceIntent into an
   * ADCOS ConnectivityIntent command. Deterministic and pure; throws a
   * typed ValidationError naming the failing stage/field on any invalid
   * input.
   */
  compile(
    intent: ExperienceIntentRecord,
    version: ExperienceIntentVersionRecord,
    options: CompileIntentOptions,
  ): CompiledIntentCommand {
    const validated: ValidatedCompilationInput = validateCompilationInput(
      intent,
      version,
      options,
    );
    const policy = normalizePolicy(validated.version.payload, validated.at);
    return serializeDigestAndCreateCommand(validated, policy);
  }
}

/**
 * Functional form of {@link ExperienceIntentCompiler.compile} (same stages,
 * same output; the class is the §4-named seam, the function is for direct
 * composition).
 */
export function compileExperienceIntent(
  intent: ExperienceIntentRecord,
  version: ExperienceIntentVersionRecord,
  options: CompileIntentOptions,
): CompiledIntentCommand {
  return new ExperienceIntentCompiler().compile(intent, version, options);
}

/** Re-exported for service-layer consumers that build their own envelopes. */
export type { CommandEnvelope };
