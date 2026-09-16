/**
 * The customer web application (RL-060).
 *
 * A PURE VIEW + COMMAND surface over the public application API
 * (spec/repository-layout.md "apps consume public application APIs/read
 * models and do not contain authority logic"):
 *
 *  - every page render fetches its data through the typed
 *    {@link @roamlink/app-kit!RoamLinkApiClient} and renders parsed
 *    resources; read failures render a typed error panel instead of the page
 *    body (fail-closed rendering - never a partial or guessed page);
 *  - every mutation goes through a flow method that carries the full command
 *    envelope (request/correlation/idempotency ids, actor/tenant context,
 *    optimistic version) and returns a {@link MutationFlowResult} the pages
 *    render as the four-stage pipeline or a typed error - the app NEVER
 *    decides outcomes itself;
 *  - flows that target an existing versioned resource read the current
 *    revision first and command against it; a lost race surfaces as the
 *    typed conflict panel (optimistic-version aware by construction).
 */
import {
  ApiClientError,
  errorPanel,
  isApiClientError,
  loadingPanel,
  mutationResultPanel,
  pageShell,
  type MutationAcknowledgement,
  type MutationFlowResult,
  type RoamLinkApiClient,
} from "@roamlink/app-kit";

import type { HtmlFragment } from "@roamlink/app-kit";
import { htmlDocument, fragment, el, text } from "@roamlink/app-kit";
import {
  commercePage,
  devicesPage,
  intentDetailPage,
  intentsPage,
  notificationsPage,
  overviewPage,
  supportPage,
} from "./pages/index.js";
import { pagePath, type WebPageName } from "./routes.js";

export interface CustomerWebAppDeps {
  readonly client: RoamLinkApiClient;
}

/** One rendered page request: the page name plus its parameters. */
export interface PageRequest {
  readonly page: WebPageName;
  readonly params?: Readonly<Record<string, string>>;
  /** The last mutation result to surface on the page (if any). */
  readonly lastResult?: MutationFlowResult;
}

const NAV = [
  { label: "Overview", href: pagePath("overview") },
  { label: "Connectivity", href: pagePath("connectivity") },
  { label: "Devices", href: pagePath("devices") },
  { label: "Experience intents", href: pagePath("intents") },
  { label: "Products & orders", href: pagePath("commerce") },
  { label: "Notifications", href: pagePath("notifications") },
  { label: "Support", href: pagePath("support") },
] as const;

export class CustomerWebApp {
  readonly #client: RoamLinkApiClient;

  constructor(deps: CustomerWebAppDeps) {
    this.#client = deps.client;
  }

  /** The typed API client (for hosts that compose flows directly). */
  client(): RoamLinkApiClient {
    return this.#client;
  }

  // ---------------------------------------------------------------------------
  // Page rendering (reads through the client; fail-closed bodies)
  // ---------------------------------------------------------------------------

  async renderDocument(request: PageRequest): Promise<string> {
    const body = await this.renderPage(request);
    return htmlDocument(
      `RoamLink - ${request.page}`,
      pageShell({
        appTitle: "RoamLink",
        navLinks: [...NAV],
        main: body,
        footerNote: "RoamLink customer web app (RL-060): a view + command surface over the public application API.",
      }),
    ).html;
  }

  async renderPage(request: PageRequest): Promise<HtmlFragment> {
    const pageBody = await this.#renderBody(request);
    return fragment(
      request.lastResult === undefined
        ? fragment()
        : mutationResultPanel(request.lastResult),
      pageBody,
    );
  }

  async #renderBody(request: PageRequest): Promise<HtmlFragment> {
    switch (request.page) {
      case "overview":
        return this.#withReads("your overview", async () => {
          const [connectivity, notifications] = await Promise.all([
            this.#client.getConnectivityOverview(),
            this.#client.listNotifications(),
          ]);
          return overviewPage({ connectivity, notifications });
        });
      case "connectivity":
        return this.#withReads("your connectivity", async () =>
          overviewPage({
            connectivity: await this.#client.getConnectivityOverview(),
            notifications: [],
          }),
        );
      case "devices":
        return this.#withReads("your devices", async () =>
          devicesPage({ devices: await this.#client.listDevices() }),
        );
      case "device":
        return this.#withReads("the device", async () =>
          devicesPage({ devices: [await this.#client.getDevice(request.params?.deviceId ?? "")] }),
        );
      case "intents":
        return this.#withReads("your experience intents", async () =>
          intentsPage({ intents: await this.#client.listExperienceIntents() }),
        );
      case "intent":
        return this.#withReads("the experience intent", async () =>
          intentDetailPage({ intent: await this.#client.getExperienceIntent(request.params?.intentId ?? "") }),
        );
      case "commerce":
        return this.#withReads("products, orders and subscriptions", async () => {
          const [products, orders, subscriptions] = await Promise.all([
            this.#client.listProducts(),
            this.#client.listOrders(),
            this.#client.listSubscriptions(),
          ]);
          return commercePage({ products, orders, subscriptions });
        });
      case "order":
        return this.#withReads("the order", async () =>
          commercePage({
            products: [],
            orders: [],
            subscriptions: [],
            orderDetail: await this.#client.getOrder(request.params?.orderId ?? ""),
          }),
        );
      case "notifications":
        return this.#withReads("your notifications", async () =>
          notificationsPage({ notifications: await this.#client.listNotifications() }),
        );
      case "support":
        return this.#withReads("your support cases", async () =>
          supportPage({ cases: await this.#client.listSupportCases() }),
        );
      case "case":
        return this.#withReads("the support case", async () => {
          const cases = await this.#client.listSupportCases();
          const wanted = request.params?.caseId ?? "";
          const found = cases.find((c) => c.caseId === wanted);
          if (found === undefined) {
            throw new ApiClientError({
              kind: "not-found",
              reason: "NOT_FOUND",
              message: "the requested support case does not exist",
              retryable: false,
              status: 404,
            });
          }
          return supportPage({ cases: [found] });
        });
    }
  }

  /**
   * Wraps one page read set: success renders the page body; ANY failure
   * renders the typed error panel instead (the page never renders partial
   * or invented content).
   */
  async #withReads(
    what: string,
    read: () => Promise<HtmlFragment>,
  ): Promise<HtmlFragment> {
    try {
      return await read();
    } catch (error) {
      if (isApiClientError(error) && error.status === 0 && error.kind === "unavailable") {
        return fragment(loadingPanel(what), errorPanel(error));
      }
      return errorPanel(error);
    }
  }

  // ---------------------------------------------------------------------------
  // Mutation flows (commands through the client; NEVER local decisions)
  // ---------------------------------------------------------------------------

  /** Enrolls a new device. */
  async enrollDeviceFlow(
    input: { readonly name: string; readonly platform: "ios" | "android" | "macos" | "windows" | "linux" | "embedded" | "other" },
    options?: { readonly idempotencyKey?: string; readonly correlationId?: string },
  ): Promise<MutationFlowResult> {
    return this.#runMutation(() =>
      this.#client.enrollDevice(input, options),
    );
  }

  /** Updates device metadata against the current revision. */
  async updateDeviceFlow(
    input: { readonly deviceId: string; readonly name?: string; readonly platform?: "ios" | "android" | "macos" | "windows" | "linux" | "embedded" | "other" },
    options?: { readonly idempotencyKey?: string; readonly correlationId?: string },
  ): Promise<MutationFlowResult> {
    return this.#runMutation(async () => {
      const device = await this.#client.getDevice(input.deviceId);
      return this.#client.updateDevice(input, {
        ...options,
        expectedVersion: device.revision,
      });
    });
  }

  /** Retires a device against the current revision. */
  async retireDeviceFlow(
    input: { readonly deviceId: string },
    options?: { readonly idempotencyKey?: string; readonly correlationId?: string },
  ): Promise<MutationFlowResult> {
    return this.#runMutation(async () => {
      const device = await this.#client.getDevice(input.deviceId);
      return this.#client.retireDevice(input, {
        ...options,
        expectedVersion: device.revision,
      });
    });
  }

  /** Creates a draft experience intent (version 1). */
  async createIntentFlow(
    input: {
      readonly deviceId: string;
      readonly rationale: string;
      readonly accessClasses: readonly ("any_internet" | "work_apps_only" | "streaming" | "low_power" | "metered_cost_cap" | "privacy_first" | "regional_compliance")[];
    },
    options?: { readonly idempotencyKey?: string; readonly correlationId?: string },
  ): Promise<MutationFlowResult> {
    return this.#runMutation(() => this.#client.createExperienceIntent(input, options));
  }

  /** Activates a draft intent against the current revision. */
  async activateIntentFlow(
    input: { readonly intentId: string },
    options?: { readonly idempotencyKey?: string; readonly correlationId?: string },
  ): Promise<MutationFlowResult> {
    return this.#runMutation(async () => {
      const intent = await this.#client.getExperienceIntent(input.intentId);
      return this.#client.activateExperienceIntent(input, {
        ...options,
        expectedVersion: intent.revision,
      });
    });
  }

  /** Supersedes an active intent with a new immutable version. */
  async supersedeIntentFlow(
    input: {
      readonly intentId: string;
      readonly rationale: string;
      readonly accessClasses: readonly ("any_internet" | "work_apps_only" | "streaming" | "low_power" | "metered_cost_cap" | "privacy_first" | "regional_compliance")[];
    },
    options?: { readonly idempotencyKey?: string; readonly correlationId?: string },
  ): Promise<MutationFlowResult> {
    return this.#runMutation(async () => {
      const intent = await this.#client.getExperienceIntent(input.intentId);
      return this.#client.supersedeExperienceIntent(input, {
        ...options,
        expectedVersion: intent.revision,
      });
    });
  }

  /** Places an order (cart lines -> placed order + pending subscription). */
  async placeOrderFlow(
    input: { readonly lines: readonly { readonly variantId: string; readonly quantity: number }[] },
    options?: { readonly idempotencyKey?: string; readonly correlationId?: string },
  ): Promise<MutationFlowResult> {
    return this.#runMutation(() => this.#client.placeOrder(input, options));
  }

  /** Records a payment for an order (money facts only - not delivery). */
  async recordPaymentFlow(
    input: { readonly orderId: string; readonly amountMinor: number; readonly currency: string },
    options?: { readonly idempotencyKey?: string; readonly correlationId?: string },
  ): Promise<MutationFlowResult> {
    return this.#runMutation(() => this.#client.recordPayment(input, options));
  }

  /** Cancels an order against the current revision. */
  async cancelOrderFlow(
    input: { readonly orderId: string },
    options?: { readonly idempotencyKey?: string; readonly correlationId?: string },
  ): Promise<MutationFlowResult> {
    return this.#runMutation(async () => {
      const detail = await this.#client.getOrder(input.orderId);
      return this.#client.cancelOrder(input, {
        ...options,
        expectedVersion: detail.order.revision,
      });
    });
  }

  /** Marks a notification read (recipient-scoped). */
  async markNotificationReadFlow(
    input: { readonly notificationId: string },
    options?: { readonly idempotencyKey?: string; readonly correlationId?: string },
  ): Promise<MutationFlowResult> {
    return this.#runMutation(() => this.#client.markNotificationRead(input, options));
  }

  /** Opens a support case. */
  async createSupportCaseFlow(
    input: {
      readonly subject: string;
      readonly description: string;
      readonly priority: "low" | "normal" | "high" | "urgent";
    },
    options?: { readonly idempotencyKey?: string; readonly correlationId?: string },
  ): Promise<MutationFlowResult> {
    return this.#runMutation(() => this.#client.createSupportCase(input, options));
  }

  async #runMutation(
    run: () => Promise<MutationAcknowledgement>,
  ): Promise<MutationFlowResult> {
    try {
      return { status: "ok", acknowledgement: await run() };
    } catch (error) {
      return { status: "error", error };
    }
  }
}

/** The shared page-heading helper for all pages. */
export function pageHeading(title: string, hint?: string): HtmlFragment {
  return fragment(
    el("h2", {}, text(title)),
    hint === undefined ? fragment() : el("p", { class: "muted" }, text(hint)),
  );
}
