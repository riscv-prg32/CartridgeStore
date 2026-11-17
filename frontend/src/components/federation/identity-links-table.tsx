"use client";

import type { FederationIdentity } from "../../lib/api/federation-admin";
import { Button } from "../ui/button";
import { Panel } from "./presentation";

type IdentityLinksTableProps = {
  identities: readonly FederationIdentity[] | undefined;
  manage: boolean;
  onRetire: (id: number) => void;
};

/** Presents linked external identities and their retire action. */
export function IdentityLinksTable({
  identities,
  manage,
  onRetire,
}: IdentityLinksTableProps) {
  return (
    <Panel title="Linked external identities">
      {identities?.length === 0 ? (
        <p className="text-sm text-[var(--color-text-muted)]">
          No identity links are configured.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-[var(--color-border)]">
                <th className="p-2">Local user</th>
                <th className="p-2">Provider</th>
                <th className="p-2">External identity</th>
                <th className="p-2">Status</th>
                <th className="p-2">Action</th>
              </tr>
            </thead>
            <tbody>
              {identities?.map((identity) => (
                <tr
                  key={identity.id}
                  className="border-b border-[var(--color-border)] last:border-0"
                >
                  <td className="p-2 font-mono">{identity.userId}</td>
                  <td className="p-2">
                    {identity.providerId}{" "}
                    <span className="text-xs uppercase text-[var(--color-text-muted)]">
                      {identity.protocol}
                    </span>
                  </td>
                  <td className="max-w-xs p-2">
                    <div className="break-all text-xs">{identity.issuer}</div>
                    <div className="break-all font-mono text-xs text-[var(--color-text-muted)]">
                      {identity.subject}
                    </div>
                  </td>
                  <td className="p-2">
                    {identity.unlinkedAt ? "Retired" : "Active"}
                  </td>
                  <td className="p-2">
                    {manage && !identity.unlinkedAt && (
                      <Button
                        variant="danger"
                        className="min-h-8 px-2 py-1 text-xs"
                        onClick={() => {
                          if (
                            window.confirm(
                              "Retire this identity link? Federated login " +
                                "through it may stop.",
                            )
                          ) {
                            onRetire(identity.id);
                          }
                        }}
                      >
                        Retire
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}
