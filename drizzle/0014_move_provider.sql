-- Move the provider from the settings row into provider_connections, encrypted. src/lib/db/index.ts registers orbit_encrypt_secret and orbit_url_host on the connection before the migrations run. An install nobody signed up to keeps its provider in pending_connection until the first account takes it, because 0015 drops the settings columns and the environment that seeded them may be gone.
INSERT INTO provider_connections (id, user_id, kind, label, base_url, api_key_ciphertext, created_at)
SELECT lower(hex(randomblob(16))), u.id, 'openai-compatible', orbit_url_host(s.base_url), s.base_url,
       orbit_encrypt_secret(s.api_key), cast(unixepoch('subsecond') * 1000 as integer)
FROM settings s JOIN (SELECT id FROM user ORDER BY created_at LIMIT 1) u
WHERE s.id = 1 AND s.base_url <> '' AND s.api_key <> '';
--> statement-breakpoint
INSERT INTO user_preferences (user_id, default_connection_id, default_model, default_effort, updated_at)
SELECT c.user_id, c.id, nullif(s.model, ''),
       CASE WHEN s.reasoning_effort IN ('low', 'medium', 'high') THEN s.reasoning_effort ELSE 'medium' END,
       cast(unixepoch('subsecond') * 1000 as integer)
FROM provider_connections c, settings s
WHERE s.id = 1
ON CONFLICT(user_id) DO UPDATE SET default_connection_id = excluded.default_connection_id,
  default_model = excluded.default_model, default_effort = excluded.default_effort, updated_at = excluded.updated_at;
--> statement-breakpoint
INSERT INTO pending_connection (id, base_url, api_key_ciphertext, model, effort, created_at)
SELECT 1, s.base_url, orbit_encrypt_secret(s.api_key), nullif(s.model, ''),
       CASE WHEN s.reasoning_effort IN ('low', 'medium', 'high') THEN s.reasoning_effort ELSE 'medium' END,
       cast(unixepoch('subsecond') * 1000 as integer)
FROM settings s
WHERE s.id = 1 AND s.base_url <> '' AND s.api_key <> '' AND NOT EXISTS (SELECT 1 FROM user);
