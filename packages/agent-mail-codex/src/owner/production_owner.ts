/**
 * C8: the single ADR-selected production owner package.
 *
 * This is intentionally the only composition root. It exports no gateway,
 * native-owner, co-control, or exec-resume fallback.
 */

import { AppServerTransport, type AppServerTransportOptions } from "./app_server_transport.ts";
import { ExclusiveHandoff } from "./handoff.ts";
import { type CompatibilityInput, requireAcceptanceCompatibility } from "./protocol_compat.ts";
import { ExactThreadLifecycle, type ThreadIdStore } from "./thread_lifecycle.ts";

export const PRODUCTION_OWNER = {
  name: "exclusive-handoff",
  transport: "private-stdio",
  authority: "single-responder",
  fallback: null,
  selectedBy: "S5",
  implementationBead: "tcp-efp.4.6",
} as const;

export interface ProductionOwnerPackage {
  descriptor: typeof PRODUCTION_OWNER;
  transport: AppServerTransport;
  lifecycle: ExactThreadLifecycle;
  handoff: ExclusiveHandoff;
}

export interface ProductionOwnerOptions {
  transport: AppServerTransportOptions;
  store: ThreadIdStore;
  threadId: string;
  compatibility: CompatibilityInput;
  now?: () => string;
}

export function createProductionOwner(options: ProductionOwnerOptions): ProductionOwnerPackage {
  requireAcceptanceCompatibility(options.compatibility);
  const transport = new AppServerTransport(options.transport);
  return {
    descriptor: PRODUCTION_OWNER,
    transport,
    lifecycle: new ExactThreadLifecycle(transport, options.store, options.now),
    handoff: new ExclusiveHandoff(options.threadId),
  };
}
