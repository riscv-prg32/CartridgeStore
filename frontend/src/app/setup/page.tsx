"use client";

import Link from "next/link";

import { SetupValidationTools } from "../../components/setup/SetupValidationTools";
import { SetupField as Field } from "../../components/setup/SetupField";
import { setupSteps as steps } from "../../components/setup/setup-steps";
import { useSetupWizard } from "../../components/setup/use-setup-wizard";

export default function SetupPage() {
  const {
    status,
    progress,
    token,
    setToken,
    current,
    setCurrent,
    form,
    busy,
    message,
    fatal,
    activeStep,
    completed,
    authorized,
    update,
    authorize,
    saveCurrent,
    finish,
    skipCurrent,
  } = useSetupWizard();
  if (fatal) {
    return (
      <main className="mx-auto max-w-3xl px-4 py-16">
        <div className="rounded-2xl border border-red-300 bg-red-50 p-6 text-red-900">
          <h1 className="text-2xl font-bold">Setup unavailable</h1>
          <p className="mt-2">{fatal}</p>
        </div>
      </main>
    );
  }

  if (!status) {
    return (
      <main className="mx-auto max-w-3xl px-4 py-16">
        <p>Checking installation readiness…</p>
      </main>
    );
  }

  if (status.state === "INSTALLATION_COMPLETE") {
    return (
      <main className="mx-auto max-w-3xl px-4 py-16">
        <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-8">
          <h1 className="text-3xl font-bold">Installation already complete</h1>
          <p className="mt-3 text-[var(--color-text-muted)]">
            Use the normal administrator login to manage the store.
          </p>
          <Link
            className="mt-6 inline-block rounded-lg bg-violet-700 px-4 py-2 font-semibold text-white"
            href="/login"
          >
            Go to login
          </Link>
        </div>
      </main>
    );
  }

  if (status.state === "INFRASTRUCTURE_NOT_READY") {
    return (
      <main className="mx-auto max-w-3xl px-4 py-16">
        <div className="rounded-2xl border border-amber-300 bg-amber-50 p-8 text-amber-950">
          <h1 className="text-3xl font-bold">Infrastructure not ready</h1>
          <p className="mt-3">
            The operator must initialize canonical storage, the writer lease and
            external secrets before installation can begin.
          </p>
          <pre className="mt-5 overflow-auto text-xs">
            {JSON.stringify(status.infrastructure, null, 2)}
          </pre>
        </div>
      </main>
    );
  }

  if (!authorized) {
    return (
      <main className="mx-auto max-w-xl px-4 py-16">
        <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-8 shadow-sm">
          <p className="text-sm font-semibold uppercase tracking-wide text-violet-700">
            PRG32 Cartridge Store
          </p>
          <h1 className="mt-2 text-3xl font-bold">First installation</h1>
          <p className="mt-3 text-[var(--color-text-muted)]">
            Enter the one-time installation authorization supplied by the
            operator. It stays only in memory and is never written to browser
            storage.
          </p>
          <Field
            label="Installation authorization"
            name="bootstrap"
            type="password"
            value={token}
            onChange={(value) => setToken(String(value))}
            required
          />
          <button
            disabled={busy || !token}
            onClick={() => void authorize()}
            className="mt-6 rounded-lg bg-violet-700 px-4 py-2 font-semibold text-white disabled:opacity-50"
          >
            {busy ? "Authorizing…" : "Start installation"}
          </button>
          {message ? (
            <p className="mt-4 text-sm" role="alert">
              {message}
            </p>
          ) : null}
        </div>
      </main>
    );
  }

  if (!progress) {
    return (
      <main className="mx-auto max-w-xl px-4 py-16">
        <p>Authorizing installation…</p>
      </main>
    );
  }

  const infra = status.infrastructure;
  return (
    <main className="mx-auto max-w-5xl px-4 py-10 sm:px-6">
      <div className="mb-8">
        <p className="text-sm font-semibold uppercase tracking-wide text-violet-700">
          First installation
        </p>
        <h1 className="mt-2 text-3xl font-bold">Configure Cartridge Store</h1>
        <p className="mt-2 text-[var(--color-text-muted)]">
          Progress is saved on the canonical server. Secrets are sent only over
          the current session and are not retained in this page after saving.
        </p>
      </div>

      <div className="grid gap-8 lg:grid-cols-[220px_1fr]">
        <aside className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
          <ol className="grid gap-2">
            {steps.map((step, index) => (
              <li key={step.id}>
                <button
                  onClick={() => setCurrent(index)}
                  className={`w-full rounded-lg px-3 py-2 text-left text-sm ${
                    index === current
                      ? "bg-violet-100 font-semibold text-violet-900"
                      : "text-[var(--color-text-muted)]"
                  }`}
                >
                  <span className="mr-2">
                    {completed.has(step.id) ? "✓" : index + 1}
                  </span>
                  {step.label}
                  {step.optional ? (
                    <span className="ml-1 text-xs">(optional)</span>
                  ) : null}
                </button>
              </li>
            ))}
          </ol>
          <div className="mt-6 border-t border-[var(--color-border)] pt-4 text-xs text-[var(--color-text-muted)]">
            Fastify: {String(infra.fastify)}
            <br />
            Canonical SQLite: {String(infra.canonical_sqlite)}
            <br />
            Writer lease: {String(infra.writer_lease)}
          </div>
        </aside>

        <section className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6 shadow-sm">
          <h2 className="text-2xl font-bold">{activeStep.label}</h2>
          <p className="mt-1 text-sm text-[var(--color-text-muted)]">
            Step {current + 1} of {steps.length}
          </p>
          <div className="mt-6 grid gap-4">
            <SetupValidationTools
              step={activeStep.id}
              csrfToken={progress.csrf_token}
              form={form}
              update={update}
            />

            {activeStep.id === "admin" ? (
              <>
                <Field
                  label="Username"
                  name="username"
                  value={String(form.username ?? "")}
                  onChange={(value) => update("username", value)}
                  required
                />
                <Field
                  label="Email"
                  name="email"
                  type="email"
                  value={String(form.email ?? "")}
                  onChange={(value) => update("email", value)}
                  required
                />
                <Field
                  label="Password"
                  name="password"
                  type="password"
                  value={String(form.password ?? "")}
                  onChange={(value) => update("password", value)}
                  required
                />
                <Field
                  label="Confirm password"
                  name="password_confirm"
                  type="password"
                  value={String(form.password_confirm ?? "")}
                  onChange={(value) => update("password_confirm", value)}
                  required
                />
              </>
            ) : null}

            {activeStep.id === "store" ? (
              <>
                <Field
                  label="Store name"
                  name="store_name"
                  value={String(form.store_name ?? "PRG32 Cartridge Store")}
                  onChange={(value) => update("store_name", value)}
                  required
                />
                <Field
                  label="Description"
                  name="store_description"
                  value={String(form.store_description ?? "")}
                  onChange={(value) => update("store_description", value)}
                />
                <Field
                  label="Contact email"
                  name="contact_email"
                  type="email"
                  value={String(form.contact_email ?? "")}
                  onChange={(value) => update("contact_email", value)}
                />
              </>
            ) : null}

            {activeStep.id === "registration" ? (
              <>
                <Field
                  label="Allow public registration"
                  name="registration_enabled"
                  type="checkbox"
                  value={Boolean(form.registration_enabled ?? true)}
                  onChange={(value) => update("registration_enabled", value)}
                />
                <Field
                  label="Require email verification"
                  name="email_verification"
                  type="checkbox"
                  value={Boolean(form.email_verification ?? false)}
                  onChange={(value) => update("email_verification", value)}
                />
              </>
            ) : null}

            {activeStep.id === "security" ? (
              <>
                <Field
                  label="Session lifetime (seconds)"
                  name="session_lifetime"
                  type="number"
                  value={String(form.session_lifetime ?? "86400")}
                  onChange={(value) => update("session_lifetime", value)}
                  required
                />
                <Field
                  label="Enable publishing"
                  name="publishing_enabled"
                  type="checkbox"
                  value={Boolean(form.publishing_enabled ?? true)}
                  onChange={(value) => update("publishing_enabled", value)}
                />
                <Field
                  label="Require a note when rejecting"
                  name="review_note"
                  type="checkbox"
                  value={Boolean(form.review_note ?? false)}
                  onChange={(value) => update("review_note", value)}
                />
              </>
            ) : null}

            {activeStep.id === "smtp" ? (
              <>
                <Field
                  label="Enable SMTP"
                  name="smtp_enabled"
                  type="checkbox"
                  value={Boolean(form.smtp_enabled ?? false)}
                  onChange={(value) => update("smtp_enabled", value)}
                  help="SMTP may remain disabled during initial installation."
                />
                <Field
                  label="SMTP host"
                  name="smtp_host"
                  value={String(form.smtp_host ?? "")}
                  onChange={(value) => update("smtp_host", value)}
                />
                <Field
                  label="SMTP port"
                  name="smtp_port"
                  type="number"
                  value={String(form.smtp_port ?? "1025")}
                  onChange={(value) => update("smtp_port", value)}
                />
                <Field
                  label="Secure SMTP connection"
                  name="smtp_secure"
                  type="checkbox"
                  value={Boolean(form.smtp_secure ?? false)}
                  onChange={(value) => update("smtp_secure", value)}
                  help="Use implicit TLS, normally with port 465."
                />
                <Field
                  label="Username"
                  name="smtp_username"
                  value={String(form.smtp_username ?? "")}
                  onChange={(value) => update("smtp_username", value)}
                />
                <Field
                  label="Password"
                  name="smtp_password"
                  type="password"
                  value={String(form.smtp_password ?? "")}
                  onChange={(value) => update("smtp_password", value)}
                />
                <Field
                  label="From email"
                  name="smtp_from_email"
                  type="email"
                  value={String(form.smtp_from_email ?? "")}
                  onChange={(value) => update("smtp_from_email", value)}
                />
              </>
            ) : null}

            {activeStep.id === "oidc" ? (
              <>
                <Field
                  label="Enable generic OIDC"
                  name="oidc_enabled"
                  type="checkbox"
                  value={Boolean(form.oidc_enabled ?? false)}
                  onChange={(value) => update("oidc_enabled", value)}
                />
                <Field
                  label="Provider ID"
                  name="oidc_provider_id"
                  value={String(form.oidc_provider_id ?? "")}
                  onChange={(value) => update("oidc_provider_id", value)}
                />
                <Field
                  label="Display name"
                  name="oidc_display_name"
                  value={String(form.oidc_display_name ?? "")}
                  onChange={(value) => update("oidc_display_name", value)}
                />
                <Field
                  label="Issuer"
                  name="oidc_issuer"
                  type="url"
                  value={String(form.oidc_issuer ?? "")}
                  onChange={(value) => update("oidc_issuer", value)}
                />
                <Field
                  label="Client ID"
                  name="oidc_client_id"
                  value={String(form.oidc_client_id ?? "")}
                  onChange={(value) => update("oidc_client_id", value)}
                />
                <Field
                  label="Client secret"
                  name="oidc_client_secret"
                  type="password"
                  value={String(form.oidc_client_secret ?? "")}
                  onChange={(value) => update("oidc_client_secret", value)}
                  help="The callback is generated by Fastify from the configured API origin."
                />
              </>
            ) : null}

            {activeStep.id === "saml" ? (
              <>
                <Field
                  label="Enable generic SAML"
                  name="saml_enabled"
                  type="checkbox"
                  value={Boolean(form.saml_enabled ?? false)}
                  onChange={(value) => update("saml_enabled", value)}
                />
                <Field
                  label="Provider ID"
                  name="saml_provider_id"
                  value={String(form.saml_provider_id ?? "")}
                  onChange={(value) => update("saml_provider_id", value)}
                />
                <Field
                  label="Display name"
                  name="saml_display_name"
                  value={String(form.saml_display_name ?? "")}
                  onChange={(value) => update("saml_display_name", value)}
                />
                <Field
                  label="IdP entity ID"
                  name="saml_idp_entity_id"
                  value={String(form.saml_idp_entity_id ?? "")}
                  onChange={(value) => update("saml_idp_entity_id", value)}
                />
                <Field
                  label="SSO URL"
                  name="saml_entry_point"
                  type="url"
                  value={String(form.saml_entry_point ?? "")}
                  onChange={(value) => update("saml_entry_point", value)}
                />
                <label
                  className="grid gap-1 text-sm font-medium"
                  htmlFor="saml_certificate"
                >
                  <span>IdP certificate</span>
                  <textarea
                    id="saml_certificate"
                    value={String(form.saml_certificate ?? "")}
                    onChange={(event) =>
                      update("saml_certificate", event.target.value)
                    }
                    rows={6}
                    className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 font-mono text-xs"
                    required
                  />
                </label>
              </>
            ) : null}

            {activeStep.id === "mdns" ? (
              <>
                <Field
                  label="Enable mDNS discovery"
                  name="mdns_enabled"
                  type="checkbox"
                  value={Boolean(form.mdns_enabled ?? false)}
                  onChange={(value) => update("mdns_enabled", value)}
                />
                <p className="text-sm text-[var(--color-text-muted)]">
                  {status.mdns.infrastructure_allowed
                    ? `Service ${status.mdns.service_type}, ABI ${status.mdns.abi}, port ${status.mdns.port}. A controlled restart is required.`
                    : "mDNS is unavailable because deployment infrastructure permission is disabled. The application will not open multicast sockets."}
                </p>
              </>
            ) : null}

            {activeStep.id === "review" ? (
              <p className="text-sm text-[var(--color-text-muted)]">
                Review the completed steps in the sidebar. Optional SMTP, OIDC,
                SAML and mDNS steps can be skipped. Completion is durable and
                disables this wizard.
              </p>
            ) : null}
          </div>

          <div className="mt-8 flex flex-wrap items-center gap-3">
            <button
              disabled={
                busy ||
                (activeStep.id === "mdns" &&
                  !status.mdns.infrastructure_allowed &&
                  Boolean(form.mdns_enabled))
              }
              onClick={() =>
                void (activeStep.id === "review" ? finish() : saveCurrent())
              }
              className="rounded-lg bg-violet-700 px-4 py-2 font-semibold text-white disabled:opacity-50"
            >
              {busy
                ? "Saving…"
                : activeStep.id === "review"
                  ? "Complete installation"
                  : completed.has(activeStep.id)
                    ? "Saved"
                    : "Save and continue"}
            </button>
            {activeStep.optional && !completed.has(activeStep.id) ? (
              <button
                disabled={busy}
                onClick={() => void skipCurrent()}
                className="rounded-lg border border-[var(--color-border)] px-4 py-2 font-semibold"
              >
                Skip
              </button>
            ) : null}
            {message ? (
              <p className="text-sm" role="alert">
                {message}
              </p>
            ) : null}
          </div>
        </section>
      </div>
    </main>
  );
}
