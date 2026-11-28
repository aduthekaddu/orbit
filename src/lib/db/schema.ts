import { sql } from "drizzle-orm";
import { check, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const user = sqliteTable("user", {
  role: text("role", { enum: ["admin", "member"] }).notNull().default("member"),
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: integer("email_verified", { mode: "boolean" }).notNull().default(false),
  image: text("image"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`),
}, (table) => [uniqueIndex("user_one_admin_idx").on(table.role).where(sql`${table.role} = 'admin'`)]);

export const session = sqliteTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    token: text("token").notNull().unique(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (table) => [index("session_userId_idx").on(table.userId)],
);

export const account = sqliteTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: integer("access_token_expires_at", { mode: "timestamp_ms" }),
    refreshTokenExpiresAt: integer("refresh_token_expires_at", { mode: "timestamp_ms" }),
    scope: text("scope"),
    password: text("password"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`),
  },
  (table) => [index("account_userId_idx").on(table.userId)],
);

export const verification = sqliteTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`),
  },
  (table) => [index("verification_identifier_idx").on(table.identifier)],
);

export const instanceSettings = sqliteTable("instance_settings", {
  id: integer("id").primaryKey(),
  hostingMode: text("hosting_mode").notNull().default("personal"),
  signupMode: text("signup_mode", { enum: ["invite", "open"] }).notNull().default("invite"),
  searxngUrl: text("searxng_url").notNull().default(""),
  tavilyKeyCiphertext: text("tavily_key_ciphertext").notNull().default(""),
  sandbox: text("sandbox", { enum: ["on", "off"] }).notNull().default("on"),
  dreamHour: integer("dream_hour").notNull().default(3),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  // Null until the startup artifact backfill finishes once. src/lib/artifacts/backfill.ts reads it on every boot.
  artifactsBackfilledAt: integer("artifacts_backfilled_at", { mode: "timestamp_ms" }),
}, (table) => [
  check("instance_settings_single_row", sql`${table.id} = 1`),
  check("instance_settings_signup_mode", sql`${table.signupMode} IN ('invite', 'open')`),
  check("instance_settings_dream_hour", sql`${table.dreamHour} >= 0 AND ${table.dreamHour} <= 23`),
]);

export const invites = sqliteTable("invites", {
  id: text("id").primaryKey(),
  tokenHash: text("token_hash").notNull().unique(),
  createdBy: text("created_by").notNull().references(() => user.id, { onDelete: "cascade" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  claimedAt: integer("claimed_at", { mode: "timestamp_ms" }),
  usedAt: integer("used_at", { mode: "timestamp_ms" }),
  usedBy: text("used_by").references(() => user.id, { onDelete: "set null" }),
}, (table) => [
  index("invites_created_by_idx").on(table.createdBy),
  index("invites_expires_at_idx").on(table.expiresAt),
]);

export const userGithub = sqliteTable("user_github", {
  userId: text("user_id").primaryKey().notNull().references(() => user.id, { onDelete: "cascade" }),
  tokenCiphertext: text("token_ciphertext").notNull().default(""),
  mcpUrl: text("mcp_url").notNull().default(""),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const providerConnections = sqliteTable(
  "provider_connections",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    label: text("label").notNull(),
    baseUrl: text("base_url"),
    apiKeyCiphertext: text("api_key_ciphertext").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    index("provider_connections_user_id_idx").on(table.userId),
    check(
      "provider_connections_base_url",
      sql`(${table.kind} = 'openai-compatible' AND ${table.baseUrl} IS NOT NULL) OR (${table.kind} = 'anthropic' AND ${table.baseUrl} IS NULL)`,
    ),
  ],
);

export const hiddenModels = sqliteTable(
  "hidden_models",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    connectionId: text("connection_id")
      .notNull()
      .references(() => providerConnections.id, { onDelete: "cascade" }),
    modelId: text("model_id").notNull(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.connectionId, table.modelId] })],
);

// The provider of an install nobody has signed up to yet. The first account takes it.
export const pendingConnection = sqliteTable(
  "pending_connection",
  {
    id: integer("id").primaryKey(),
    baseUrl: text("base_url").notNull(),
    apiKeyCiphertext: text("api_key_ciphertext").notNull(),
    model: text("model"),
    effort: text("effort").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [check("pending_connection_single_row", sql`${table.id} = 1`)],
);

export const chats = sqliteTable(
  "chats",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    headId: text("head_id"),
    title: text("title").notNull().default("New chat"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
    // Set together or all null, only through setChatChoice. A foreign key would null one of the three.
    connectionId: text("connection_id"),
    model: text("model"),
    reasoningEffort: text("reasoning_effort"),
  },
  (table) => [index("chats_user_id_idx").on(table.userId)],
);

export const messages = sqliteTable(
  "messages",
  {
    id: text("id").primaryKey(),
    chatId: text("chat_id")
      .notNull()
      .references(() => chats.id, { onDelete: "cascade" }),
    parentId: text("parent_id"),
    role: text("role").notNull(),
    content: text("content").notNull(),
    parts: text("parts").notNull(),
    position: integer("position").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    connectionId: text("connection_id").references(() => providerConnections.id, { onDelete: "set null" }),
    model: text("model"),
    reasoningEffort: text("reasoning_effort"),
    effortOutcome: text("effort_outcome"),
  },
  (table) => [index("messages_chat_position_idx").on(table.chatId, table.position), index("messages_chat_parent_idx").on(table.chatId, table.parentId)],
);

export const memories = sqliteTable(
  "memories",
  {
    seq: integer("seq").primaryKey({ autoIncrement: true }),
    id: text("id").notNull().unique(),
    userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    text: text("text").notNull(),
    textNorm: text("text_norm").notNull(),
    source: text("source", { enum: ["user", "tool", "dream", "unknown"] }).notNull().default("unknown"),
    sourceChatId: text("source_chat_id").references(() => chats.id, { onDelete: "set null" }),
    sourceMessageId: text("source_message_id").references(() => messages.id, { onDelete: "set null" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    lastUsedAt: integer("last_used_at", { mode: "timestamp_ms" }),
  },
  (table) => [
    index("memories_user_id_idx").on(table.userId),
    uniqueIndex("memories_user_text_norm_idx").on(table.userId, table.textNorm),
  ],
);

// One row per HTML, SVG, or React block in a saved assistant reply. `seq` is the stable rowid of artifacts_fts.
// Every version in a lineage holds the lineage's user_title, so a rename touches every row and search sees it on each.
export const artifacts = sqliteTable(
  "artifacts",
  {
    seq: integer("seq").primaryKey({ autoIncrement: true }),
    id: text("id").notNull().unique(),
    userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    chatId: text("chat_id").notNull().references(() => chats.id, { onDelete: "cascade" }),
    messageId: text("message_id").notNull().references(() => messages.id, { onDelete: "cascade" }),
    textOrdinal: integer("text_ordinal").notNull(),
    blockIndex: integer("block_index").notNull(),
    kind: text("kind", { enum: ["html", "svg", "react"] }).notNull(),
    language: text("language", { enum: ["html", "svg", "jsx", "tsx"] }).notNull(),
    code: text("code").notNull(),
    derivedTitle: text("derived_title").notNull(),
    userTitle: text("user_title"),
    lineageId: text("lineage_id").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    check("artifacts_slot_nonneg", sql`${table.textOrdinal} >= 0 AND ${table.blockIndex} >= 0`),
    check(
      "artifacts_kind_language",
      sql`(${table.kind} = 'html' AND ${table.language} = 'html') OR (${table.kind} = 'svg' AND ${table.language} = 'svg') OR (${table.kind} = 'react' AND ${table.language} IN ('jsx', 'tsx'))`,
    ),
    uniqueIndex("artifacts_message_slot_idx").on(table.messageId, table.textOrdinal, table.blockIndex),
    index("artifacts_user_updated_idx").on(table.userId, table.updatedAt, table.seq),
    index("artifacts_user_lineage_idx").on(table.userId, table.lineageId, table.createdAt, table.seq),
    index("artifacts_chat_idx").on(table.chatId),
  ],
);

export const memoryRuns = sqliteTable("memory_runs", {
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  date: text("date").notNull(),
  state: text("state").notNull(),
  startedAt: integer("started_at", { mode: "timestamp_ms" }).notNull(),
  finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
  owner: text("owner"),
  leaseUntil: integer("lease_until", { mode: "timestamp_ms" }),
  chatIds: text("chat_ids").notNull(),
  doneChatIds: text("done_chat_ids").notNull(),
  retryChatIds: text("retry_chat_ids").notNull(),
  added: integer("added").notNull(),
  merged: integer("merged").notNull(),
  error: text("error"),
}, (table) => [primaryKey({ columns: [table.userId, table.date] })]);

export const userPreferences = sqliteTable("user_preferences", {
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  memory: text("memory", { enum: ["on", "off"] }).notNull().default("on"),
  theme: text("theme").notNull().default("dark"),
  textSize: text("text_size").notNull().default("md"),
  replyFont: text("reply_font").notNull().default("sans"),
  chatWidth: text("chat_width").notNull().default("normal"),
  accent: text("accent").notNull().default("sun"),
  defaultConnectionId: text("default_connection_id").references(() => providerConnections.id, { onDelete: "set null" }),
  defaultModel: text("default_model"),
  defaultEffort: text("default_effort"),
  providerSetupComplete: integer("provider_setup_complete", { mode: "boolean" }).notNull().default(false),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});
