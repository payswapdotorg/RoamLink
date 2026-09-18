/**
 * The customer web application (RL-060 + RL-082/083).
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
 *
 * RL-083: the app renders inside the @roamlink/app-kit application shell
 * (warm-light, desktop sidebar + mobile bottom navigation, persistent
 * connectivity status derived from the authoritative read model with its
 * facts shown). The shell is a presentation boundary (ADR-0002): no
 * authority, no local connectivity state machine — the indicator is derived
 * ONLY from the parsed ConnectivityOverviewResource and renders honestly
 * when the read itself fails.
 *
 * RL-082: the four-step first-run onboarding lives in pages/onboarding-page;
 * its finish flow is the ONLY onboarding mutation path and goes through the
 * same envelope as every other command.
 */
import {
  ApiClientError,
  applicationShell,
  errorPanel,
  isApiClientError,
  loadingPanel,
  mutationResultPanel,
  shellConnectivityIndicator,
  WARM_SHELL_STYLES,
  type MutationAcknowledgement,
  type MutationFlowResult,
  type RoamLinkApiClient,
} from "@roamlink/app-kit";

import type { HtmlFragment } from "@roamlink/app-kit";
import { el, fragment, htmlDocument, text } from "@roamlink/app-kit";
import {
  activityPage,
  commercePage,
  devicesPage,
  homePage,
  intentDetailPage,
  intentsPage,
  morePage,
  notificationsPage,
  overviewPage,
  settingsPage,
  supportPage,
} from "./pages/index.js";
import { pagePath, type WebPageName } from "./routes.js";
import { WEB_APP_STYLES } from "./styles.js";

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

/**
 * The exact customer navigation (spec/ux-architecture.md §3). Desktop:
 * Home | Connectivity | Activity | Devices | Goals | Plans & Billing |
 * Support. Mobile: Home | Connect | Activity | Devices | More.
 * Routes stay stable; labels are human (Goals renders the ExperienceIntent
 * surface, Plans & Billing renders commerce).
 */
export const DESKTOP_NAV = [
  { label: "Home", href: pagePath("home") },
  { label: "Connectivity", href: pagePath("connectivity") },
  { label: "Activity", href: pagePath("activity") },
  { label: "Devices", href: pagePath("devices") },
  { label: "Goals", href: pagePath("intents") },
  { label: "Plans & Billing", href: pagePath("commerce") },
  { label: "Support", href: pagePath("support") },
] as const;

export const MOBILE_NAV = [
  { label: "Home", href: pagePath("home") },
  { label: "Connect", href: pagePath("connectivity") },
  { label: "Activity", href: pagePath("activity") },
  { label: "Devices", href: pagePath("devices") },
  { label: "More", href: pagePath("more") },
] as const;

/** Nav href for a page (drives aria-current in the shell). */
function activeNavHref(page: WebPageName): string {
  const candidates: Record<WebPageName, string> = {
    home: pagePath("home"),
    connectivity: pagePath("connectivity"),
    activity: pagePath("activity"),
    notifications: pagePath("activity"),
    devices: pagePath("devices"),
    device: pagePath("devices"),
    intents: pagePath("intents"),
    intent: pagePath("intents"),
    commerce: pagePath("commerce"),
    order: pagePath("commerce"),
    support: pagePath("support"),
    case: pagePath("support"),
    more: pagePath("more"),
    settings: pagePath("settings"),
    overview: pagePath("overview"),
  };
  return candidates[page];
}

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
      applicationShell({
        appTitle: "RoamLink",
        homeHref: pagePath("home"),
        sidebarLinks: [...DESKTOP_NAV],
        bottomNavItems: [...MOBILE_NAV],
        activeHref: activeNavHref(request.page),
        connectivityIndicator: await this.#shellIndicator(),
        main: body,
        footerNote:
          "RoamLink is your Connectivity Experience OS. The shell is a presentation boundary: your connectivity state comes from authoritative reads, with evidence and freshness.",
      }),
      { styles: [WARM_SHELL_STYLES, WEB_APP_STYLES] },
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

  /**
   * The persistent shell indicator: derived ONLY from the authoritative
   * connectivity read. If the read fails, renders the honest "cannot
   * confirm" state — never a guessed status (the page body itself fails
   * closed independently).
   */
  async #shellIndicator() {
    try {
      const overview = await this.#client.getConnectivityOverview();
      return shellConnectivityIndicator({
        subjects: overview.subjects,
        detailsHref: pagePath("connectivity"),
      });
    } catch {
      return shellConnectivityIndicator({
        subjects: null,
        detailsHref: pagePath("connectivity"),
      });
    }
  }

  async #renderBody(request: PageRequest): Promise<HtmlFragment> {
    switch (request.page) {
      case "home":
        return this.#withReads("your connectivity", async () => {
          const [connectivity, intents, devices, notifications] = await Promise.all([
            this.#client.getConnectivityOverview(),
            this.#client.listExperienceIntents(),
            this.#client.listDevices(),
            this.#client.listNotifications(),
          ]);
          return homePage({ connectivity, intents, devices, notifications });
        });
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
      case "activity":
        return this.#withReads("your activity", async () => {
          const [notifications, intents, devices] = await Promise.all([
            this.#client.listNotifications(),
            this.#client.listExperienceIntents(),
            this.#client.listDevices(),
          ]);
          return activityPage({ notifications, intents, devices });
        });
      case "devices":
        return this.#withReads("your devices", async () =>
          devicesPage({ devices: await this.#client.listDevices() }),
        );
      case "device":
        return this.#withReads("the device", async () =>
          devicesPage({ devices: [await this.#client.getDevice(request.params?.deviceId ?? "")] }),
        );
      case "intents":
        return this.#withReads("your goals", async () =>
          intentsPage({ intents: await this.#client.listExperienceIntents() }),
        );
      case "intent":
        return this.#withReads("the goal", async () =>
          intentDetailPage({ intent: await this.#client.getExperienceIntent(request.params?.intentId ?? "") }),
        );
      case "commerce":
        return this.#withReads("your plans and billing", async () => {
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
      case "more":
        return morePage();
      case "settings":
        return this.#withReads("your settings", async () =>
          settingsPage({ session: await this.#client.getActorSession() }),
        );
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
