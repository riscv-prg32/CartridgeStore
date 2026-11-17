const baseUrl = process.env.PRG32_UI93_BACKEND_URL;
const bootstrapToken = process.env.PRG32_UI93_TEST_BOOTSTRAP_TOKEN;
const adminPassword = "ui93-disposable-admin-password-2026";
const userPassword = "ui93-disposable-password-2026";

if (!baseUrl || !bootstrapToken) throw new Error("UI.9.3 auth contract runner requires the disposable backend URL and bootstrap token");

function sessionCookie(headers) {
  const value = headers.get("set-cookie") || "";
  const match = value.match(/prg32_ts_session=([^;]+)/);
  return match?.[1] ? `prg32_ts_session=${match[1]}` : "";
}

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { accept: "application/json", ...(options.body ? { "content-type": "application/json" } : {}), ...(options.headers || {}) },
  });
  const body = await response.json().catch(() => ({}));
  return { response, body };
}

function expectStatus(result, status, label) {
  if (result.response.status !== status) throw new Error(`${label} returned HTTP ${result.response.status}; expected ${status}`);
}

async function login(username, password) {
  const csrf = await request("/auth/csrf");
  expectStatus(csrf, 200, `${username} CSRF`);
  const cookie = sessionCookie(csrf.response.headers);
  const result = await request("/auth/login", {
    method: "POST",
    headers: { cookie, "x-csrftoken": csrf.body.csrf_token },
    body: JSON.stringify({ username, password }),
  });
  expectStatus(result, 200, `${username} login`);
  return { cookie: sessionCookie(result.response.headers) || cookie, csrfToken: csrf.body.csrf_token };
}

const anonymous = await request("/auth/me");
expectStatus(anonymous, 401, "anonymous session check");

const csrf = await request("/auth/csrf");
expectStatus(csrf, 200, "anonymous CSRF issuance");
const anonymousCookie = sessionCookie(csrf.response.headers);
const missingCsrf = await request("/auth/login", {
  method: "POST",
  headers: { cookie: anonymousCookie },
  body: JSON.stringify({ username: "ui93-admin", password: adminPassword }),
});
expectStatus(missingCsrf, 403, "missing CSRF login");

const admin = await login("ui93-admin", adminPassword);
const adminMe = await request("/auth/me", { headers: { cookie: admin.cookie } });
expectStatus(adminMe, 200, "admin session check");
const users = await request("/api/admin/users", { headers: { cookie: admin.cookie } });
expectStatus(users, 200, "admin user listing");
const adminMutationWithoutCsrf = await request("/api/admin/users", {
  method: "POST",
  headers: { cookie: admin.cookie },
  body: JSON.stringify({ username: "ui93-no-write", email: "ui93-no-write@example.test", password: userPassword, password_confirm: userPassword, role: "user", group_ids: [] }),
});
expectStatus(adminMutationWithoutCsrf, 403, "admin mutation without CSRF");

const user = await login("ui93-user-a", userPassword);
const userAdminView = await request("/api/admin/users", { headers: { cookie: user.cookie } });
expectStatus(userAdminView, 403, "ordinary-user admin authorization");
const creator = await login("ui93-creator", userPassword);
const drafts = await request("/api/drafts", { headers: { cookie: creator.cookie } });
expectStatus(drafts, 200, "creator draft listing");
const creatorCsrf = await request("/auth/csrf", { headers: { cookie: creator.cookie } });
expectStatus(creatorCsrf, 200, "creator CSRF");
const draft = await request("/api/drafts", {
  method: "POST",
  headers: { cookie: creator.cookie, "x-csrftoken": creatorCsrf.body.csrf_token },
  body: JSON.stringify({ metadata: {} }),
});
expectStatus(draft, 201, "creator draft creation");
const deletedDraft = await request(`/api/drafts/${encodeURIComponent(draft.body.draft.id)}`, {
  method: "DELETE",
  headers: { cookie: creator.cookie, "x-csrftoken": creatorCsrf.body.csrf_token },
});
expectStatus(deletedDraft, 200, "creator draft deletion");

const logoutCsrf = await request("/auth/csrf", { headers: { cookie: creator.cookie } });
const logout = await request("/auth/logout", { method: "POST", headers: { cookie: creator.cookie, "x-csrftoken": logoutCsrf.body.csrf_token } });
expectStatus(logout, 200, "creator logout");
const afterLogout = await request("/auth/me", { headers: { cookie: creator.cookie } });
expectStatus(afterLogout, 401, "post-logout session check");

console.log("UI.9.3 authenticated API contract checks passed: anonymous, CSRF, login, session, admin/RBAC, creator drafts and logout");
