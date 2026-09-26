/**
 * Component-scoped degradation tests (PA-020): the quiet unavailable panel
 * and the secondary-read composition helper.
 *
 * These are the app-kit gates for the panel contract the customer and admin
 * pages render:
 *  - the panel renders ONLY what is known - the title, the typed reason
 *    (the WHY) and one what-this-means line; no retry affordance that
 *    cannot work, no invented data, no full-page alarm styling;
 *  - `optionalRead` degrades a SECONDARY read exactly on the
 *    unavailability-class typed errors (unavailable / not-found /
 *    rate-limited - the typed 501 READ_MODEL_NOT_COMPOSED being the
 *    canonical case) and re-throws everything else so the existing honest
 *    page-level fail-closed law keeps holding (authorization refusals and
 *    contract-integrity failures NEVER render partial surfaces).
 */
import { describe, expect, it } from "vitest";

import {
  ApiClientError,
  isUnavailableRead,
  optionalRead,
  unavailablePanel,
  unavailablePanelFor,
} from "../src/index.js";

/** The real runtime's kept-501 body shape (services/api readModelNotComposed). */
function notComposed(namedCode: string, explanation: string): ApiClientError {
  return new ApiClientError({
    kind: "unavailable",
    reason: "READ_MODEL_NOT_COMPOSED",
    message: `this read model has no composed source on the real runtime (${namedCode}: ${explanation}); no data is invented here`,
    retryable: false,
    status: 501,
  });
}

const NOT_COMPOSED_501 = notComposed(
  "NOTIFICATION_STORE_NOT_BOUND",
  "notifications are emitted from durable domain transitions; no notification store is bound on this runtime",
);

describe("the quiet unavailable panel (PA-020)", () => {
  it("renders ONLY what is known: title, typed reason, contract-borne why, one meaning line", () => {
    const panel = unavailablePanel({
      section: "home-attention",
      reason: NOT_COMPOSED_501.reason,
      message: NOT_COMPOSED_501.message,
      meaning: "The attention items cannot be shown right now; the rest of the page still renders.",
    });
    expect(panel.html).toContain("Not available right now");
    expect(panel.html).toContain("<code>READ_MODEL_NOT_COMPOSED</code>");
    // The WHY: the contract-borne explanation renders (safe text - the same
    // discipline as errorPanel), including the named reason.
    expect(panel.html).toContain("NOTIFICATION_STORE_NOT_BOUND");
    expect(panel.html).toContain(
      "The attention items cannot be shown right now; the rest of the page still renders.",
    );
    // The section-scoped machine surface (what the page batteries scan).
    expect(panel.html).toContain('data-unavailable="true"');
    expect(panel.html).toContain('data-unavailable-section="home-attention"');
    expect(panel.html).toContain('data-unavailable-reason="READ_MODEL_NOT_COMPOSED"');
  });

  it("offers no retry affordance and no invented data (a quiet block, not an alarm)", () => {
    const panel = unavailablePanel({
      section: "audit-events",
      reason: "READ_MODEL_NOT_COMPOSED",
      meaning: "The event record cannot be shown right now.",
    });
    expect(panel.html).not.toContain("<button");
    expect(panel.html).not.toContain("retry");
    // Without a contract-borne message nothing is guessed in its place.
    expect(panel.html).not.toContain("undefined");
    expect(panel.html).not.toContain("null");
    // NOT full-page alarm styling (the error panel keeps its own class).
    expect(panel.html).not.toContain("panel error");
  });

  it("unavailablePanelFor renders the panel from a narrowed unavailable marker", () => {
    const marker = { unavailable: true, reason: "NOT_FOUND", message: null } as const;
    const panel = unavailablePanelFor(marker, {
      section: "enterprise-workspace",
      meaning: "The workspace composition cannot be shown right now.",
    });
    expect(panel.html).toContain('data-unavailable-section="enterprise-workspace"');
    expect(panel.html).toContain("<code>NOT_FOUND</code>");
    expect(panel.html).toContain("The workspace composition cannot be shown right now.");
  });
});

describe("isUnavailableRead (the marker guard)", () => {
  it("narrows arrays, resources and the marker correctly", () => {
    expect(isUnavailableRead({ unavailable: true, reason: "X", message: null })).toBe(true);
    expect(isUnavailableRead([{ notificationId: "n" }])).toBe(false);
    expect(isUnavailableRead({ some: "resource" })).toBe(false);
    expect(isUnavailableRead(null)).toBe(false);
    expect(isUnavailableRead(undefined)).toBe(false);
  });
});

describe("optionalRead (the secondary-read composition helper)", () => {
  it("returns the parsed value when the source answers", async () => {
    const outcome = await optionalRead(() => Promise.resolve([{ a: 1 }]));
    expect(outcome).toEqual([{ a: 1 }]);
    expect(isUnavailableRead(outcome)).toBe(false);
  });

  it("degrades the typed 501 READ_MODEL_NOT_COMPOSED into the section marker (reason + why)", async () => {
    const outcome = await optionalRead(() => {
      throw NOT_COMPOSED_501;
    });
    if (!isUnavailableRead(outcome)) throw new Error("expected the unavailable marker");
    expect(outcome.reason).toBe("READ_MODEL_NOT_COMPOSED");
    expect(outcome.message).toContain("NOTIFICATION_STORE_NOT_BOUND");
  });

  it("degrades the not-composed route's honest 404 (the real workspace runtime shape)", async () => {
    const outcome = await optionalRead(() => {
      throw new ApiClientError({
        kind: "not-found",
        reason: "NOT_FOUND",
        message: "no such route",
        retryable: false,
        status: 404,
      });
    });
    if (!isUnavailableRead(outcome)) throw new Error("expected the unavailable marker");
    expect(outcome.reason).toBe("NOT_FOUND");
  });

  it("degrades transport failures and rate limits (the source did not answer)", async () => {
    const transport = await optionalRead(() => {
      throw ApiClientError.transportFailure("the API transport failed");
    });
    expect(isUnavailableRead(transport)).toBe(true);
    const limited = await optionalRead(() => {
      throw new ApiClientError({
        kind: "rate-limited",
        reason: "RATE_LIMITED",
        message: "too many requests",
        retryable: true,
        status: 429,
      });
    });
    expect(isUnavailableRead(limited)).toBe(true);
  });

  it("re-throws authorization refusals - the page-level fail-closed law keeps holding", async () => {
    await expect(
      optionalRead(() => {
        throw new ApiClientError({
          kind: "unauthorized",
          reason: "ORGANIZATION_TENANT_REQUIRED",
          message: "the enterprise workspace requires an organization tenant scope",
          retryable: false,
          status: 403,
        });
      }),
    ).rejects.toMatchObject({ kind: "unauthorized" });
  });

  it("re-throws contract-integrity failures (never masks a broken contract with a quiet panel)", async () => {
    await expect(
      optionalRead(() => {
        throw ApiClientError.unparseableErrorBody(200);
      }),
    ).rejects.toMatchObject({ kind: "unknown-state" });
    await expect(
      optionalRead(() => {
        throw new ApiClientError({
          kind: "validation",
          reason: "READ_CONTEXT_INCOMPLETE",
          message: "the tenant context header is required for business reads",
          retryable: false,
          status: 400,
        });
      }),
    ).rejects.toMatchObject({ kind: "validation" });
  });
});
