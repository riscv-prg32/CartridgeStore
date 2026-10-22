# Claude Task Brief: Complete the GDPR and Privacy Remediation

You are working in the **PRG32 Cartridge Store** repository. Implement every
remediation in this brief, update the documentation, add regression tests, and
leave the repository in a releasable state.

Do not merely describe the changes. Make the changes and verify them.

## Repository

- Product name: **Cartridge Store**
- Platform name: **PRG32**
- Repository root: `/Users/raffaelemontella/devel/riscv-prg32/CartridgeStore`
- Primary application: Flask/PWA
- Storage: filesystem cartridge store plus unified SQLite database
- Current privacy implementation: `cartridge_store/privacy.py`
- Current privacy notice: `templates/privacy.html`
- Current privacy operations guide: `docs/gdpr.md`

Read and follow the repository's `AGENTS.md` before editing. Preserve all
documented API compatibility requirements and public metadata ABI names.

## Objective

Resolve every finding from the 22 October 2026 privacy audit. The result must:

1. stop exposing account email addresses as public identifiers;
2. make erasure complete and internally consistent;
3. make the privacy notice deployment-specific and Article 13/14 ready;
4. provide a complete Article 15 access package;
5. protect sensitive browser actions with CSRF and recent authentication;
6. accurately record privacy-notice delivery;
7. avoid reversibly hashed email addresses in privacy audit records;
8. enforce retention through a schedulable command rather than web traffic;
9. migrate existing installations safely and idempotently;
10. preserve firmware and API compatibility.

Do not claim that software alone guarantees GDPR compliance. The application
must provide strong technical controls while clearly assigning deployment and
legal decisions to the controller.

## Finding 1: Email Addresses Are Public Identifiers

### Current defect

Local registration uses the email address as both `users.email` and
`users.username` in `cartridge_store/auth/__init__.py`. The username is then
disclosed through several public or shared surfaces:

- `GET /users/<username>` and `templates/user_profile.html`;
- public score API and leaderboard `submitted_by` fields;
- metrics `submitted_by` fields and reports;
- cartridge catalog/index `published_by` fields;
- editor submission and review display fields.

The audit reproduced an unauthenticated disclosure of
`student@example.test` through `/api/scores` and
`/users/student@example.test`.

### Required remediation

- Separate private account identity from public display identity.
- Add a stable, non-email public handle or display-name field to `users`.
- Never derive a public identifier directly from an email address.
- During local registration, ask the user for a public handle/display name or
  generate an opaque default that contains no email local-part or domain.
- Validate public handles with an explicit length and safe-character policy.
- Keep email private to the account owner and authorised administrators.
- Do not expose email through profiles, scores, runs, reports, catalog JSON,
  publisher fields, reviewer fields, templates, or API responses.
- Preserve existing API field names such as `submitted_by` and `published_by`
  where compatibility requires them, but populate them with the public handle.
- Ensure renaming a handle does not corrupt ownership. Ownership must use
  immutable numeric user IDs, not display strings.
- Decide whether public user profiles are necessary. If retained, address them
  by an opaque public ID or validated handle and expose only intentionally
  public fields.

### Existing-data migration

- Add columns idempotently with `add_column_if_missing` or a deliberate
  migration mechanism.
- For users whose username is an email, generate a unique opaque handle such
  as `player-<random-or-id-derived-value>` without embedding the email.
- Do not rewrite historical strings by matching username alone when that could
  affect another person. Use stored user IDs wherever available.
- Migrate denormalised public fields only when ownership can be proven.
- Document any legacy record that cannot be safely attributed and default it
  to a neutral label such as `legacy user` rather than an email address.

## Finding 2: Erasure Is Incomplete

### Current defect

`erase_user()` anonymises `scores.submitted_by` and
`cartridge_submissions.submitted_by`, but it leaves other identifiers behind,
including:

- `cartridge_submissions.reviewed_by`;
- catalog/index `published_by` fields;
- publisher values inside stored version/architecture records;
- possibly author/developer data in cartridge metadata and colophons;
- SSO outbox payloads and other linked operational records.

The UI currently promises that shared classroom records are anonymised, which
is not always true.

### Required remediation

- Build a documented personal-data inventory covering SQLite tables,
  filesystem index JSON, pending submissions, cartridge metadata/colophons,
  backup/export artifacts, and SSO state.
- Update every denormalised submitter, reviewer, and publisher identifier that
  can be linked to the erased account.
- Use immutable user IDs for future records and derive current display values
  at presentation time where practical.
- Remove account-owned runs, samples, tokens, download events, registration
  records, sessions, and queued SSO records.
- Anonymise shared records only when retention is justified.
- Do not automatically remove authorship or public creative credits when an
  Article 17 exception or another legal basis may apply. Instead:
  - distinguish account identifiers from intentionally published authorship;
  - present the distinction clearly before erasure;
  - create an administrator workflow for exceptional/manual review;
  - record the controller's decision without retaining unnecessary identity.
- Make local erasure and linked Construction Kit deletion retry-safe.
- Ensure a failed SSO delivery is queued without restoring the deleted local
  account.
- Update the privacy notice and account-erasure UI so their promises exactly
  match the implemented behavior.

### Transaction requirements

- Perform the local database portion in one explicit transaction.
- Roll back on failure.
- Make filesystem/catalog updates atomic using the store's locking and
  temporary-file patterns.
- Make repeated erasure requests safe and idempotent.

## Finding 3: Privacy Notice Uses Hypothetical Lawful Bases

### Current defect

`templates/privacy.html` lists alternatives such as “contract or public task or
legitimate interests” rather than the basis actually selected by the deploying
controller. It also tells the operator to document recipients and transfers
elsewhere instead of showing the configured information to data subjects.

### Required remediation

Add administrator-configurable, purpose-specific privacy settings. At minimum:

- controller identity and address;
- representative, where applicable;
- privacy contact and DPO contact;
- each processing purpose;
- the selected Article 6 lawful basis for each purpose;
- the specific legitimate interest when Article 6(1)(f) is selected;
- categories of personal data;
- recipients/categories of recipients;
- third-country/international transfers;
- adequacy decision or Article 46/47/49 mechanism and how to obtain safeguards;
- retention period or concrete retention criteria for every category;
- whether providing each field is statutory, contractual, or necessary to
  enter a contract, plus consequences of not providing it;
- source categories for data obtained from LDAP/OIDC/SAML/SSO;
- applicable data-subject rights;
- right to withdraw consent, only when consent is actually used;
- right to complain to the configured supervisory authority;
- automated decision-making statement;
- notice version and effective date.

Do not allow the production-ready status to pass while required notice fields
are blank or contain unresolved alternatives. Provide an administrator privacy
readiness page that reports missing items.

The public `/privacy` page must render the configured, actual choices. Keep
legal text clear and understandable for learners, including children where the
deployment serves them.

## Finding 4: The Personal-Data Export Is Incomplete

### Current defect

`GET /api/me/export` exports selected account/database rows but omits personal
data in other locations, including catalog publisher fields, cartridge
metadata/colophons, reviewer activity, SSO outbox data, and privacy-event data.
It also does not provide all Article 15 processing information.

### Required remediation

- Create one authoritative data-inventory service used by both export and
  erasure.
- Include all personal data linked to the requester across:
  - account and authentication records;
  - groups, roles, and token metadata, never token secrets or hashes;
  - scores and player identifiers attributable to the user;
  - metrics runs and samples;
  - downloads and pseudonymous telemetry attributable to the account;
  - submissions and review actions;
  - catalog publisher records;
  - metadata and colophon data attributable to the person;
  - SSO queues/synchronisation state;
  - privacy and rights-request audit records;
  - any other repository-discovered personal data.
- Include Article 15 information: purposes, categories, recipients, retention,
  source, rights, complaint information, transfer safeguards, and automated
  decision-making information.
- Keep the export structured, machine-readable JSON with a versioned ABI.
- Exclude secrets, password hashes, API-token hashes, other users' personal
  data, and information that would adversely affect another person's rights.
- Clearly distinguish a portability export from a full access response if both
  are offered.
- Protect exports with `Cache-Control: no-store, private`, appropriate content
  disposition, CSRF where applicable, and recent authentication.

## Finding 5: CSRF and Recent Authentication Are Missing

### Current defect

Sensitive browser actions—including account deletion—use ordinary POST forms
without an application-level CSRF token. Export and deletion rely on any valid
session without checking that authentication is recent.

### Required remediation

- Add robust CSRF protection to every state-changing browser route, not only
  privacy routes.
- Preserve Bearer-token API compatibility. Do not require browser CSRF tokens
  for properly authenticated non-cookie API requests.
- Use per-session unpredictable tokens with constant-time validation or a
  maintained Flask CSRF library.
- Update every affected HTML form and its tests.
- Require recent authentication for personal-data export and account erasure.
- For local accounts, require the current password or a recent-login marker.
- For OIDC/SAML/SSO accounts, use an appropriate recent re-authentication flow.
- Do not accept a predictable text field such as `DELETE` as the only security
  control. It may remain as a usability confirmation.
- Rotate/clear the session after account changes and erasure.
- Consider rate limiting authentication, export, and deletion attempts.

Also add or document production security headers as appropriate, including a
tested Content Security Policy and HSTS at the HTTPS boundary. Do not break
custom theming without an explicit safe policy.

## Finding 6: Notice-Delivery Records Are Inaccurate

### Current defect

`mark_privacy_notice_delivered()` runs after local account creation even for an
API flow where the notice was never rendered. OIDC and SAML users do not get a
corresponding delivery record.

### Required remediation

- Record notice delivery only when the exact version was actually presented in
  the relevant onboarding flow.
- Cover local browser registration, JSON/API registration, OIDC, SAML, LDAP if
  enabled later, and Construction Kit SSO.
- For API registration, include the notice URL/version in the first response
  before collecting more data, or require an explicit version acknowledgement.
- An acknowledgement is evidence of presentation, not necessarily consent.
  Never describe it as consent unless consent is the chosen lawful basis and
  all consent requirements are met.
- Store version, presentation timestamp, channel, and appropriate evidence.
- Prompt existing users when a materially changed notice version becomes
  effective.
- Make the notice accessible without authentication.

## Finding 7: Privacy Audit Hash Is Reversible

### Current defect

`privacy_events.subject_hash` uses unsalted SHA-256 of the email address and is
retained for a hard-coded six years. Known or guessed email addresses can be
tested against that hash.

### Required remediation

- Prefer a random request/event identifier that does not encode identity.
- If later correlation is genuinely necessary, use a purpose-specific keyed
  HMAC secret that is separate from the Flask session secret and supports
  rotation.
- Never store raw email in the privacy event after erasure.
- Document the exact purpose and lawful basis for the audit event.
- Make its retention configurable and choose the shortest justified default.
- Ensure audit records contain only what is necessary: event type, random
  reference, timestamps, status, and non-identifying decision metadata.
- Test that an erased email cannot be recovered or directly verified from the
  retained event.

## Finding 8: Retention Depends on Web Traffic

### Current defect

Retention cleanup runs from `before_request` using a process-local monotonic
timer. Dormant services do not clean data, and multiple workers have independent
timers.

### Required remediation

- Move retention work out of request handling.
- Add an idempotent Flask CLI command, for example:

  ```bash
  flask --app app:app privacy-cleanup
  ```

- Support a dry-run/report mode.
- Return structured counts and a non-zero exit status on failure.
- Keep the authenticated administrator endpoint only if useful, but make it
  invoke the same service and protect it with CSRF/recent authentication.
- Document cron, systemd timer, Docker, and Kubernetes CronJob examples as
  appropriate to this project.
- Store last-success and last-failure status for the privacy readiness page
  without retaining unnecessary personal data.
- Alert or prominently warn when cleanup has not succeeded within the expected
  interval.
- Add retention coverage for SSO queues and any other temporary personal data.
- Continue to document that proxy logs, SMTP logs, IdP logs, exports, and
  backups require separate retention controls.

## Data Model and Compatibility Rules

- Keep migrations idempotent.
- Preserve existing public endpoint paths and old response fields.
- Add optional fields rather than removing or renaming fields.
- Keep SQLite foreign keys enabled.
- Use `ON DELETE` behavior deliberately and test it.
- Do not put uploaded cartridge binaries in SQLite.
- Preserve `PRG32_STORE_DATA`, `PRG32_STORE_DB`, and legacy database fallbacks.
- Keep `cartridge_store/sso_protocol.py` identical to the companion
  Construction Kit copy.
- Every user create/update/delete path must continue to call the required SSO
  synchronization function.
- Do not change PRG32 metadata ABI names, discovery ABI, architecture strings,
  mDNS service type, or port requirements.

## Required Tests

Add focused regression tests for at least the following:

1. A newly registered email never appears in anonymous/public profile, score,
   metrics, catalog, or discovery responses.
2. Existing email-as-username users receive safe unique public handles during
   migration.
3. Public handles cannot be emails and reject unsafe/ambiguous input.
4. Ownership and authorization use user IDs after a handle changes.
5. Erasure removes or anonymises submitter, reviewer, publisher, telemetry,
   SSO, token, run, and sample data as specified.
6. Erasure updates filesystem catalog records atomically.
7. Published authorship subject to manual/legal review is not silently erased;
   the request enters the documented workflow.
8. Article 15 export covers every inventory source and excludes secrets and
   other users' data.
9. Browser POST requests without a valid CSRF token fail.
10. Bearer-token API clients remain compatible without browser CSRF tokens.
11. Export and erasure fail without recent authentication.
12. Local, OIDC, SAML, and SSO onboarding record the actual notice version and
    channel at the correct event.
13. Privacy events cannot be matched using plain SHA-256 of a known email.
14. CLI cleanup dry-run and execution produce correct counts.
15. Cleanup covers expired registrations, telemetry, metrics, SSO queues, and
    configured audit events.
16. Privacy readiness reports incomplete controller configuration and stale
    cleanup status.
17. The last-administrator safety rule remains enforced.
18. Existing API response fields and firmware-facing endpoints remain intact.

Include negative tests and migration tests against a database created with the
schema that existed before this remediation.

## Documentation Updates

Update at least:

- `README.md` hard requirements;
- `docs/gdpr.md`;
- `docs/deployment.md`;
- `docs/operations.md`;
- `docs/api.md`;
- privacy architecture diagram under `docs/images/`;
- any screenshots affected by changed registration, setup, privacy-readiness,
  export, or erasure screens.

Document:

- the actual behavior and remaining controller responsibilities;
- safe migration from email usernames;
- scheduled cleanup setup and monitoring;
- access-versus-portability exports;
- erasure exceptions and manual-review workflow;
- CSRF and recent-authentication behavior;
- backup erasure/expiry expectations;
- how to review and update the privacy notice version.

Do not state that the application is “fully”, “perfectly”, or automatically
GDPR compliant.

## Validation

Before reporting completion, run:

```bash
python3 -m py_compile app.py cartridge_store/*.py
pytest -q
git diff --check
```

For Docker/documentation deployment changes, also run when Docker is available:

```bash
docker compose config
docker build -t prg32-cartridge-store:local .
```

Report unavailable validation explicitly.

## Completion Report

When finished, provide:

1. a concise description of the implemented privacy model;
2. schema and migration details;
3. every public/API compatibility decision;
4. tests added and exact validation results;
5. remaining controller/legal responsibilities;
6. any intentionally deferred item with justification;
7. the final `git status --short` output.

Do not commit or push unless the user separately requests it.
