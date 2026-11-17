/**
 * Canonical TanStack Query identities owned by each frontend domain.
 *
 * Keep response-affecting parameters in the key. These factories are data-only
 * so they can be used by readers, mutations, and tests without a React
 * dependency.
 */
export const authQueryKeys = {
  all: ["auth"] as const,
  currentUser: () => ["auth", "current-user"] as const,
  providers: () => ["auth", "providers"] as const,
  tokens: () => ["auth", "tokens"] as const,
  passkeys: () => ["auth", "passkeys"] as const,
} as const;

export const workflowQueryKeys = {
  all: ["workflow"] as const,
  submissionsRoot: () => ["workflow", "submissions"] as const,
  principal: () => ["workflow", "principal"] as const,
  drafts: () => ["workflow", "drafts"] as const,
  submissions: (status?: string) => ["workflow", "submissions", status ?? "all"] as const,
  mineRoot: () => ["workflow", "submissions", "mine"] as const,
  mine: (page: number, status?: string) => ["workflow", "submissions", "mine", status ?? "all", page] as const,
  submission: (id: number | null) => ["workflow", "submission", id] as const,
} as const;

export const reviewQueryKeys = {
  queue: (status: string) => workflowQueryKeys.submissions(status),
  submission: (id: number | null) => workflowQueryKeys.submission(id),
} as const;

export const adminQueryKeys = {
  all: ["admin"] as const,
  principal: () => ["admin", "principal"] as const,
  settings: () => ["admin", "settings"] as const,
  usersRoot: () => ["admin", "users"] as const,
  users: (filters: { page?: number; search?: string } = {}) => ["admin", "users", filters.page ?? 1, filters.search ?? ""] as const,
  user: (id: number | null) => ["admin", "user", id] as const,
  groups: () => ["admin", "groups"] as const,
  roles: () => ["admin", "roles"] as const,
  tokens: (filters: { page?: number; userId?: number } = {}) => ["admin", "tokens", filters.page ?? 1, filters.userId ?? null] as const,
  tokensRoot: () => ["admin", "tokens"] as const,
  catalogRoot: () => ["admin", "catalog"] as const,
  catalog: (filters: { moderation?: boolean; page?: number; limit?: number; status?: string } = {}) => ["admin", "catalog", filters.moderation === true ? "moderation" : "published", filters.status ?? "all", filters.page ?? 1, filters.limit ?? 24] as const,
  cartridge: (id: string | null, version?: string) => ["admin", "cartridge", id, version ?? null] as const,
  audit: (limit = 100) => ["admin", "audit", limit] as const,
  auditEvent: (eventId: string | null) => ["admin", "audit-event", eventId] as const,
} as const;

export const catalogQueryKeys = {
  list: (filters: { query?: string; page?: number; perPage?: number } = {}) => ["catalog", filters.query ?? "", filters.page ?? 1, filters.perPage ?? 100] as const,
  game: (id: string, version?: string | null) => ["catalog", "game", id, version ?? null] as const,
} as const;

export const metricsQueryKeys = {
  all: ["metrics"] as const,
  runs: () => ["metrics", "runs"] as const,
  run: (runId: string) => ["metrics", "run", runId] as const,
} as const;

export const profileQueryKeys = {
  user: (username: string) => ["profile", username] as const,
  runs: (username: string, page = 1) => ["profile", username, "runs", page] as const,
  run: (username: string, runId: string) => ["profile", username, "run", runId] as const,
} as const;

export const statisticsQueryKeys = {
  downloads: (filters: { since?: string; until?: string; granularity?: string; limit?: number } = {}) => ["statistics", "downloads", filters] as const,
  gameDownloads: (gameId: string, filters: { since?: string; until?: string; granularity?: string; limit?: number } = {}) => ["statistics", "downloads", gameId, filters] as const,
  scores: (limit = 5) => ["statistics", "scores", limit] as const,
  runs: () => ["statistics", "runs"] as const,
} as const;

export const scoresQueryKeys = {
  list: (filters: { game?: string; player?: string; limit?: number } = {}) => ["scores", filters.game ?? "", filters.player ?? "", filters.limit ?? 20] as const,
} as const;

export const setupQueryKeys = {
  status: () => ["setup", "status"] as const,
  progress: () => ["setup", "progress"] as const,
} as const;

export const federationQueryKeys = {
  all: ["federation"] as const,
  providers: () => ["federation", "providers"] as const,
  provider: (id: string) => ["federation", "provider", id] as const,
  status: (id: string) => ["federation", "status", id] as const,
  identities: () => ["federation", "identities"] as const,
} as const;
