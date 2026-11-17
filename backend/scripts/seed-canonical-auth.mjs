import Database from "better-sqlite3";

const canonical = new Database("/canonical/store.sqlite");
const auth = new Database("/writer-data/auth.sqlite", { readonly: true });

try {
  canonical.pragma("foreign_keys = ON");
  canonical.exec("BEGIN IMMEDIATE");

  // The writer database is only a bootstrap source. Keep password_hash and
  // session state owned by the canonical database after the first import.
  const copyUser = canonical.prepare(`
    INSERT INTO users (id, username, email, password_hash, role, external_id, external_provider, created_at, last_login, disabled_at)
    VALUES (@id, @username, @email, @password_hash, @role, @external_id, @external_provider, @created_at, @last_login, @disabled_at)
    ON CONFLICT(id) DO UPDATE SET
      username = excluded.username,
      email = excluded.email,
      role = excluded.role,
      external_id = excluded.external_id,
      external_provider = excluded.external_provider,
      last_login = excluded.last_login,
      disabled_at = excluded.disabled_at
  `);
  const copyGroup = canonical.prepare(`
    INSERT INTO groups (id, name, created_at)
    VALUES (@id, @name, @created_at)
    ON CONFLICT(id) DO UPDATE SET name = excluded.name
  `);
  const copyMembership = canonical.prepare(`
    INSERT OR IGNORE INTO user_groups (user_id, group_id) VALUES (?, ?)
  `);

  for (const user of auth.prepare("SELECT id, username, email, password_hash, role, external_id, external_provider, created_at, last_login, disabled_at FROM users").all()) {
    copyUser.run(user);
  }
  for (const group of auth.prepare("SELECT id, name, created_at FROM groups").all()) {
    copyGroup.run(group);
  }
  for (const membership of auth.prepare("SELECT user_id, group_id FROM user_groups").all()) {
    copyMembership.run(membership.user_id, membership.group_id);
  }

  canonical.exec("COMMIT");
  console.log("Canonical auth mirror updated");
} catch (error) {
  if (canonical.inTransaction) canonical.exec("ROLLBACK");
  throw error;
} finally {
  auth.close();
  canonical.close();
}
