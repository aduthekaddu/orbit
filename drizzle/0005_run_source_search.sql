-- Add the source of code runs to the search text of messages saved before search read it. 0004 already added the output, and the source goes after it, as searchTextFromParts writes it. The triggers from 0002 keep the index in sync.
UPDATE messages
SET content = CASE WHEN content = '' THEN '' ELSE content || char(10) END || (
  SELECT group_concat(json_extract(p.value, '$.input.code'), char(10) ORDER BY p.key)
  FROM json_each(messages.parts) AS p
  WHERE json_extract(p.value, '$.type') = 'tool-run_code'
    AND json_type(p.value, '$.input.code') = 'text'
    AND trim(json_extract(p.value, '$.input.code'), char(9, 10, 13, 32)) <> ''
)
WHERE role = 'assistant' AND json_valid(parts) AND json_type(parts) = 'array' AND parts LIKE '%"tool-run_code"%' AND EXISTS (
  SELECT 1 FROM json_each(messages.parts) AS p
  WHERE json_extract(p.value, '$.type') = 'tool-run_code'
    AND json_type(p.value, '$.input.code') = 'text'
    AND trim(json_extract(p.value, '$.input.code'), char(9, 10, 13, 32)) <> ''
);
