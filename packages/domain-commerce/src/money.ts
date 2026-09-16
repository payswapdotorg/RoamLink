/**
 * Money value object (RL-020/RL-021 commerce foundations).
 *
 * Customer-facing commercial amounts ONLY: catalog prices, order line unit
 * price snapshots, and (Wave 3, RL-022) payments/invoices/refunds. This is
 * PRESENTATION-facing commerce money, structurally separate from ADCOS
 * commercial settlement (RL-LOCK-008: payment is not delivery; RoamLink
 * commerce state is distinct from ADCOS settlement state).
 *
 * Representation: integer MINOR units (cents, fen, ...) + ISO-4217-style
 * alpha-3 currency code. Integers avoid floating-point money bugs entirely;
 * minor units are the conventional fintech representation. The currency is
 * validated for SHAPE (3 uppercase letters) - maintaining the full ISO-4217
 * active-currency table is a composition/policy concern, not a contract one.
 */
import { ValidationError, type Branded } from "@roamlink/contracts";

/** A validated commercial money value. */
export type Money = Branded<"Money">;

/** The plain (serialized) form of a money value. */
export interface MoneyValue {
  /** Non-negative integer amount in the currency's minor units. */
  readonly amountMinorUnits: number;
  /** ISO-4217-style alpha-3 currency code (uppercase). */
  readonly currency: string;
}

export const MAX_AMOUNT_MINOR_UNITS = 9_007_199_254_740_991; // Number.MAX_SAFE_INTEGER

const CURRENCY_PATTERN = /^[A-Z]{3}$/;

function field(label: string, issue: string): never {
  throw new ValidationError(`Money rejected: ${label} - ${issue}`, {
    reason: "MONEY_INVALID",
    details: [{ path: label, issue }],
  });
}

/** Parses and freezes a money value (closed fields, fail-closed). */
export function parseMoneyValue(value: unknown): MoneyValue {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    field("$", "must be an object with amountMinorUnits and currency");
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!["amountMinorUnits", "currency"].includes(key)) {
      field(key, "unknown field (the money vocabulary is closed)");
    }
  }
  const amount = record["amountMinorUnits"];
  if (
    typeof amount !== "number" ||
    !Number.isInteger(amount) ||
    amount < 0 ||
    amount > MAX_AMOUNT_MINOR_UNITS
  ) {
    field("amountMinorUnits", "must be a non-negative safe integer of minor units");
  }
  const currency = record["currency"];
  if (typeof currency !== "string" || !CURRENCY_PATTERN.test(currency)) {
    field("currency", "must be an ISO-4217-style alpha-3 uppercase code");
  }
  return Object.freeze({ amountMinorUnits: amount, currency });
}

/** Equality (both components). */
export function moneyEquals(a: MoneyValue, b: MoneyValue): boolean {
  return a.amountMinorUnits === b.amountMinorUnits && a.currency === b.currency;
}

/** Adds two SAME-CURRENCY amounts (throws on currency mismatch). */
export function addMoney(a: MoneyValue, b: MoneyValue): MoneyValue {
  if (a.currency !== b.currency) {
    throw new ValidationError(
      "Money rejected: currency - amounts in different currencies cannot be added (present the components, never a silent conversion)",
      {
        reason: "MONEY_CURRENCY_MISMATCH",
        details: [{ path: "currency", issue: "the operands use different currencies" }],
      },
    );
  }
  const sum = a.amountMinorUnits + b.amountMinorUnits;
  if (sum > MAX_AMOUNT_MINOR_UNITS) {
    field("amountMinorUnits", "the sum overflows safe integer minor units");
  }
  return Object.freeze({ amountMinorUnits: sum, currency: a.currency });
}

/** Multiplies an amount by an integer quantity (order line totals). */
export function multiplyMoney(amount: MoneyValue, quantity: number): MoneyValue {
  if (typeof quantity !== "number" || !Number.isInteger(quantity) || quantity < 1 || quantity > 100) {
    field("quantity", "must be an integer between 1 and 100");
  }
  const product = amount.amountMinorUnits * quantity;
  if (product > MAX_AMOUNT_MINOR_UNITS) {
    field("amountMinorUnits", "the product overflows safe integer minor units");
  }
  return Object.freeze({ amountMinorUnits: product, currency: amount.currency });
}
