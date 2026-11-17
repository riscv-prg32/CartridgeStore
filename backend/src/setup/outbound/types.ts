/** Error raised when an outbound provider target fails validation or fetch. */
export class OutboundValidationError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "OutboundValidationError";
  }
}

/** Resolved outbound target and lookup pinning used by provider fetches. */
export interface ValidatedOutboundTarget {
  readonly hostname: string;
  readonly port: number;
  readonly address: string;
  readonly family: 4 | 6;
  readonly allowlisted: boolean;
  readonly lookup: LookupFunction;
}

/** DNS lookup seam used by deterministic outbound validation tests. */
export type Lookup = (
  hostname: string,
  options: { all: true; verbatim?: boolean },
) => Promise<Array<{ address: string; family: number }>>;

/** Options shared by outbound URL validation and bounded fetches. */
export interface OutboundTargetOptions {
  readonly allowedProtocols?: readonly ("http:" | "https:")[];
  readonly defaultPort?: number;
  readonly lookup?: Lookup;
}
import type { LookupFunction } from "node:net";
