/**
 * The ADCOS Developer API version pin (RL-030, RL-LOCK-017).
 *
 * SINGLE SITE: `ADCOS_API_VERSION` is the one and only definition of the
 * ADCOS API version this integration targets (the request-header value and
 * the compatibility baseline). It is consistent with the supported-versions
 * pin in `@roamlink/contracts` (`SUPPORTED_ADCOS_API_VERSIONS`) and with the
 * fail-closed env schema (`ADCOS_API_VERSION` env key) - a conformance test
 * asserts all three agree. Any future bump is an additive contract change
 * coordinated through the ADCOS compatibility suite (RL-036).
 */
import { type AdcosApiVersion } from "@roamlink/contracts";

/** The pinned ADCOS Developer API version. Current and only line: 2.0. */
export const ADCOS_API_VERSION: AdcosApiVersion = "2.0";
