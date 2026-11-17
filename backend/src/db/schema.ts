import { relations, sql } from "drizzle-orm";
import { index, integer, primaryKey, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";

export const users = sqliteTable(
  "users",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    username: text("username").notNull().unique(),
    email: text("email").notNull().unique(),
    passwordHash: text("password_hash"),
    role: text("role").notNull().default("user"),
    externalId: text("external_id"),
    externalProvider: text("external_provider"),
    createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
    lastLogin: text("last_login"),
    disabledAt: text("disabled_at")
  },
  (table) => ({
    externalIndex: index("users_external_idx").on(table.externalProvider, table.externalId)
  })
);

export const apiTokens = sqliteTable(
  "api_tokens",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    label: text("label"),
    createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
    lastUsed: text("last_used")
  },
  (table) => ({ userIndex: index("api_tokens_user_idx").on(table.userId) })
);

export const groups = sqliteTable(
  "groups",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull().unique(),
    createdAt: text("created_at").notNull().default(sql`(datetime('now'))`)
  }
);

export const userGroups = sqliteTable(
  "user_groups",
  {
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    groupId: integer("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" })
  },
  (table) => ({
    primary: primaryKey({ columns: [table.userId, table.groupId] })
  })
);

export const registrationTokens = sqliteTable(
  "registration_tokens",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    email: text("email").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
    expiresAt: text("expires_at").notNull(),
    usedAt: text("used_at")
  },
  (table) => ({
    emailIndex: index("registration_tokens_email_idx").on(
      table.email,
      table.usedAt,
      table.expiresAt
    )
  })
);

export const storeSettings = sqliteTable("store_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull()
});

export const runs = sqliteTable(
  "runs",
  {
    runId: text("run_id").primaryKey(),
    boardId: text("board_id").notNull(),
    target: text("target").notNull(),
    displayBackend: text("display_backend").notNull().default(""),
    firmwareVersion: text("firmware_version").notNull().default(""),
    firmwareGitSha: text("firmware_git_sha").notNull().default(""),
    gameName: text("game_name").notNull().default(""),
    samplePeriodFrames: integer("sample_period_frames").notNull().default(1),
    startedAt: integer("started_at").notNull(),
    finishedAt: integer("finished_at"),
    droppedSamples: integer("dropped_samples").notNull().default(0),
    createdAt: integer("created_at").notNull().default(sql`(strftime('%s', 'now'))`),
    submittedBy: text("submitted_by").notNull().default(""),
    userId: integer("user_id").references(() => users.id)
  }
);

export const samples = sqliteTable(
  "samples",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    runId: text("run_id")
      .notNull()
      .references(() => runs.runId, { onDelete: "cascade" }),
    frame: integer("frame").notNull(),
    timestampMs: integer("timestamp_ms").notNull(),
    updateUs: integer("update_us").notNull(),
    drawUs: integer("draw_us").notNull(),
    presentUs: integer("present_us").notNull(),
    frameUs: integer("frame_us").notNull(),
    heapFree: integer("heap_free").notNull(),
    heapMinFree: integer("heap_min_free").notNull(),
    inputMask: integer("input_mask").notNull(),
    fpsX100: integer("fps_x100").notNull(),
    uploadQueueDepth: integer("upload_queue_depth").notNull(),
    deadlineMissed: integer("deadline_missed").notNull().default(0),
    createdAt: integer("created_at").notNull().default(sql`(strftime('%s', 'now'))`)
  },
  (table) => ({
    runFrameUnique: unique().on(table.runId, table.frame),
    runFrameIndex: index("samples_run_frame_idx").on(table.runId, table.frame),
    runFrameTimeIndex: index("samples_run_frame_time_idx").on(table.runId, table.frameUs)
  })
);

export const scores = sqliteTable(
  "scores",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    game: text("game").notNull(),
    player: text("player").notNull(),
    score: integer("score").notNull(),
    createdAt: integer("created_at").notNull(),
    submittedBy: text("submitted_by").notNull().default("")
  },
  (table) => ({
    gameScoreIndex: index("scores_game_score_idx").on(
      table.game,
      sql`${table.score} DESC`,
      sql`${table.createdAt} ASC`
    )
  })
);

export const downloadEvents = sqliteTable(
  "download_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    gameId: text("game_id").notNull(),
    version: text("version").notNull(),
    architecture: text("architecture").notNull(),
    userId: integer("user_id"),
    ipHash: text("ip_hash"),
    userAgent: text("user_agent"),
    downloadedAt: text("downloaded_at").notNull().default(sql`(datetime('now'))`)
  },
  (table) => ({
    gameIndex: index("download_events_game_idx").on(table.gameId, table.downloadedAt),
    architectureIndex: index("download_events_arch_idx").on(table.architecture)
  })
);

export const cartridgeSubmissions = sqliteTable(
  "cartridge_submissions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    gameId: text("game_id").notNull(),
    version: text("version").notNull(),
    status: text("status").notNull().default("pending"),
    submittedByUserId: integer("submitted_by_user_id").references(() => users.id, {
      onDelete: "set null"
    }),
    submittedBy: text("submitted_by").notNull().default(""),
    reviewedByUserId: integer("reviewed_by_user_id").references(() => users.id, {
      onDelete: "set null"
    }),
    reviewedBy: text("reviewed_by").notNull().default(""),
    pendingDir: text("pending_dir").notNull().default(""),
    metadataJson: text("metadata_json").notNull(),
    architecturesJson: text("architectures_json").notNull(),
    createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
    reviewedAt: text("reviewed_at")
  },
  (table) => ({
    statusIndex: index("cartridge_submissions_status_idx").on(table.status, table.createdAt)
  })
);

export const usersRelations = relations(users, ({ many }) => ({
  apiTokens: many(apiTokens),
  userGroups: many(userGroups),
  runs: many(runs),
  submittedCartridges: many(cartridgeSubmissions, { relationName: "submittedBy" }),
  reviewedCartridges: many(cartridgeSubmissions, { relationName: "reviewedBy" })
}));

export const apiTokensRelations = relations(apiTokens, ({ one }) => ({
  user: one(users, { fields: [apiTokens.userId], references: [users.id] })
}));

export const userGroupsRelations = relations(userGroups, ({ one }) => ({
  user: one(users, { fields: [userGroups.userId], references: [users.id] }),
  group: one(groups, { fields: [userGroups.groupId], references: [groups.id] })
}));

export const runsRelations = relations(runs, ({ one, many }) => ({
  user: one(users, { fields: [runs.userId], references: [users.id] }),
  samples: many(samples)
}));

export const samplesRelations = relations(samples, ({ one }) => ({
  run: one(runs, { fields: [samples.runId], references: [runs.runId] })
}));

export const cartridgeSubmissionsRelations = relations(cartridgeSubmissions, ({ one }) => ({
  submittedByUser: one(users, {
    fields: [cartridgeSubmissions.submittedByUserId],
    references: [users.id],
    relationName: "submittedBy"
  }),
  reviewedByUser: one(users, {
    fields: [cartridgeSubmissions.reviewedByUserId],
    references: [users.id],
    relationName: "reviewedBy"
  })
}));

export const schema = {
  users,
  apiTokens,
  groups,
  userGroups,
  registrationTokens,
  storeSettings,
  runs,
  samples,
  scores,
  downloadEvents,
  cartridgeSubmissions
};
