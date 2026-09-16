/**
 * The violation toggle (RL-070, RL-LOCK-018 negative-proof discipline).
 *
 * Every conformance suite in this package proves its lock in TWO modes:
 *
 *  1. GREEN PROOF (default): the current tree satisfies the lock. The
 *     violating fixture/input is REJECTED (behavioral suites) or the
 *     structural scan of the real repository comes back clean.
 *
 *  2. NEGATIVE PROOF (red-on-violation): each suite is bound to exactly one
 *     violating fixture. Setting the environment variable
 *
 *         ROAMLINK_CONFORMANCE_VIOLATION=<LOCK-ID>
 *
 *     (e.g. RL-LOCK-008) TOGGLES THAT FIXTURE ON: behavioral suites flip the
 *     expectation to the violating side (asserting the violating input IS
 *     accepted - which a conforming tree fails), and structural suites scan
 *     the real tree PLUS a virtual overlay carrying the violating file (a
 *     scan that then finds the violation and goes red).
 *
 *     The toggle therefore demonstrates, reproducibly and without editing
 *     any package source, that the suite FAILS when the implementation
 *     exhibits the violation - RL-LOCK-018: "conformance tests must FAIL
 *     when an implementation violates an authority or dependency lock, not
 *     merely when a happy path breaks".
 *
 * Toggled runs are EXPECTED to be red in exactly the one suite whose lock id
 * was named; every other suite stays green. See README.md for the exact
 * reproduction commands.
 */

/** The environment variable that names the toggled-on violation. */
export const VIOLATION_ENV_VAR = "ROAMLINK_CONFORMANCE_VIOLATION";

/** The lock ids this suite knows how to toggle (documentation value). */
export const TOGGLEABLE_LOCK_IDS = [
  "RL-LOCK-001",
  "RL-LOCK-002",
  "RL-LOCK-003",
  "RL-LOCK-004",
  "RL-LOCK-005",
  "RL-LOCK-006",
  "RL-LOCK-007",
  "RL-LOCK-008",
  "RL-LOCK-009",
  "RL-LOCK-010",
  "RL-LOCK-011",
  "RL-LOCK-012",
  "RL-LOCK-013",
  "RL-LOCK-014",
  "RL-LOCK-015",
  "RL-LOCK-016",
  "RL-LOCK-017",
  "RL-LOCK-019",
] as const;

/** The lock id whose violating fixture is toggled on, when any. */
export function activeViolation(): string | null {
  const value = process.env[VIOLATION_ENV_VAR];
  return value !== undefined && value !== "" ? value : null;
}

/** True exactly when this lock's violating fixture is toggled on. */
export function violationEnabled(lockId: string): boolean {
  return activeViolation() === lockId;
}

/**
 * Explains the toggle in failure messages: when a toggled suite fails, the
 * message reminds the operator WHY (this is the negative proof firing).
 */
export function toggleHint(lockId: string): string {
  return violationEnabled(lockId)
    ? `[negative proof fired] ${lockId}'s violating fixture is toggled ON via ${VIOLATION_ENV_VAR}=${lockId}; a conforming tree MUST fail this assertion. Unset the variable for the green proof.`
    : `set ${VIOLATION_ENV_VAR}=${lockId} to toggle this lock's violating fixture on (the suite must then go red)`;
}
