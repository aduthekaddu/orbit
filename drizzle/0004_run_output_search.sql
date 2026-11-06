-- Add the standard output and standard error of finished code runs to the search text of messages saved before search read them. The triggers from 0002 keep the index in sync. orbit_clean_output removes terminal escape sequences. src/lib/db/index.ts registers it on the connection before the migrations run.
UPDATE messages
SET content = CASE WHEN content = '' THEN '' ELSE content || char(10) END || (
  SELECT group_concat(piece, char(10)) FROM (
    SELECT orbit_clean_output(json_extract(p.value, '$.output.stdout')) AS piece
    FROM json_each(messages.parts) AS p
    WHERE json_extract(p.value, '$.type') = 'tool-run_code' AND json_extract(p.value, '$.state') = 'output-available'
      AND trim(orbit_clean_output(coalesce(json_extract(p.value, '$.output.stdout'), '')), char(9, 10, 13, 32)) <> ''
    UNION ALL
    SELECT orbit_clean_output(json_extract(p.value, '$.output.stderr')) AS piece
    FROM json_each(messages.parts) AS p
    WHERE json_extract(p.value, '$.type') = 'tool-run_code' AND json_extract(p.value, '$.state') = 'output-available'
      AND trim(orbit_clean_output(coalesce(json_extract(p.value, '$.output.stderr'), '')), char(9, 10, 13, 32)) <> ''
  )
)
WHERE role = 'assistant' AND json_valid(parts) AND parts LIKE '%"tool-run_code"%' AND EXISTS (
  SELECT 1 FROM json_each(messages.parts) AS p
  WHERE json_extract(p.value, '$.type') = 'tool-run_code' AND json_extract(p.value, '$.state') = 'output-available'
    AND (trim(orbit_clean_output(coalesce(json_extract(p.value, '$.output.stdout'), '')), char(9, 10, 13, 32)) <> ''
      OR trim(orbit_clean_output(coalesce(json_extract(p.value, '$.output.stderr'), '')), char(9, 10, 13, 32)) <> '')
);
