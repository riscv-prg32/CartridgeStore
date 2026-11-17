"use client";

import type { FederationProvider } from "../../lib/api/federation-admin";
import { Button } from "../ui/button";
import { TextArea } from "./presentation-primitives";

/** Shows trusted certificates and manages replacement sets. */
export function CertificatePanel({
  provider,
  certificates,
  setCertificates,
  manage,
  mutation,
  request,
}: {
  provider: FederationProvider;
  certificates: string;
  setCertificates: (value: string) => void;
  manage: boolean;
  mutation: {
    isPending: boolean;
    mutate: (certificates: string[]) => void;
  };
  request: (action: () => void, clear?: () => void) => void;
}) {
  return (
    <div className="mt-5 border-t border-[var(--color-border)] pt-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="font-semibold">Trusted IdP certificates</h3>
          <p className="mt-1 text-sm text-[var(--color-text-muted)]">
            {provider.trusted_certificate_count}/
            {provider.trusted_certificate_capacity} trusted certificates. PEM
            is never returned by the backend.
          </p>
        </div>
      </div>
      <div className="mt-3 space-y-3">
        {provider.certificates.map((certificate, index) => (
          <div
            key={certificate.fingerprint}
            className="rounded-md border border-[var(--color-border)] p-3 text-xs"
          >
            <p className="font-semibold">Certificate {index + 1}</p>
            <p className="mt-1 break-all font-mono">
              SHA-256 {certificate.fingerprint}
            </p>
            {certificate.valid_to && (
              <p className="mt-1 text-[var(--color-text-muted)]">
                Valid until {certificate.valid_to}
              </p>
            )}
          </div>
        ))}
        {manage && (
          <>
            <TextArea
              label="Replacement trust set"
              value={certificates}
              onChange={(event) => setCertificates(event.target.value)}
              hint={
                "Paste one or two PEM values separated by a blank line. " +
                "This replaces the trust set; it does not expose existing PEM."
              }
            />
            <Button
              variant="secondary"
              disabled={!certificates.trim() || mutation.isPending}
              onClick={() => {
                if (
                  window.confirm(
                    "Replace the trusted certificate set? Pending transactions may be affected.",
                  )
                ) {
                  request(
                    () =>
                      mutation.mutate(
                        certificates
                          .split(/\n\s*\n/)
                          .map((item) => item.trim())
                          .filter(Boolean),
                      ),
                    () => setCertificates(""),
                  );
                }
              }}
            >
              {mutation.isPending ? "Updating…" : "Replace certificates"}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
