import { sql } from "drizzle-orm";
import { check, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const user = sqliteTable("user", {
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
});

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

export const settings = sqliteTable("settings", {
  id: integer("id").primaryKey(),
  searxngUrl: text("searxng_url").notNull().default(""),
  tavilyApiKey: text("tavily_api_key").notNull().default(""),
  githubToken: text("github_token").notNull().default(""),
  githubMcpUrl: text("github_mcp_url").notNull().default(""),
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
    kind: text("kind").notNull(),
    text: text("text").notNull(),
    textNorm: text("text_norm").notNull(),
    source: text("source", { enum: ["user", "tool", "dream", "unknown"] }).notNull().default("unknown"),
    sourceChatId: text("source_chat_id").references(() => chats.id, { onDelete: "set null" }),
    sourceMessageId: text("source_message_id").references(() => messages.id, { onDelete: "set null" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    lastUsedAt: integer("last_used_at", { mode: "timestamp_ms" }),
  },
  (table) => [uniqueIndex("memories_text_norm_idx").on(table.textNorm)],
);

export const memoryRuns = sqliteTable("memory_runs", {
  date: text("date").primaryKey(),
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
});

export const userPreferences = sqliteTable("user_preferences", {
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  theme: text("theme").notNull().default("dark"),
  textSize: text("text_size").notNull().default("md"),
  replyFont: text("reply_font").notNull().default("sans"),
  chatWidth: text("chat_width").notNull().default("normal"),
  accent: text("accent").notNull().default("sun"),
  defaultConnectionId: text("default_connection_id").references(() => providerConnections.id, { onDelete: "set null" }),
  defaultModel: text("default_model"),
  defaultEffort: text("default_effort"),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});
