-- Add the standard output and standard error of finished code runs to the search text of messages saved before search read them. The triggers from 0002 keep the index in sync. orbit_clean_output removes terminal escape sequences. src/lib/db/index.ts registers it on the connection before the migrations run.
UPDATE messages
SET content = CASE WHEN content = '' THEN '' ELSE content || char(10) END || (
  SELECT group_concat(piece, char(10) ORDER BY piece_order)
  FROM (
    SELECT orbit_clean_output(json_extract(p.value, c.path)) AS piece, p.key * 2 + c.channel AS piece_order
    FROM json_each(messages.parts) AS p
    CROSS JOIN (SELECT 0 AS channel, '$.output.stdout' AS path UNION ALL SELECT 1, '$.output.stderr') AS c
    WHERE json_extract(p.value, '$.type') = 'tool-run_code' AND json_extract(p.value, '$.state') = 'output-available'
      AND trim(orbit_clean_output(coalesce(json_extract(p.value, c.path), '')), char(9, 10, 13, 32)) <> ''
  )
)
WHERE role = 'assistant' AND json_valid(parts) AND parts LIKE '%"tool-run_code"%' AND EXISTS (
  SELECT 1
  FROM json_each(messages.parts) AS p
  CROSS JOIN (SELECT '$.output.stdout' AS path UNION ALL SELECT '$.output.stderr') AS c
  WHERE json_extract(p.value, '$.type') = 'tool-run_code' AND json_extract(p.value, '$.state') = 'output-available'
    AND trim(orbit_clean_output(coalesce(json_extract(p.value, c.path), '')), char(9, 10, 13, 32)) <> ''
);
