export function visibleMemories<T>(query: string, initial: readonly T[], fetched: { query: string; rows: readonly T[] } | null): readonly T[] {
  const trimmed = query.trim();
  if (!trimmed) return initial;
  if (!fetched || fetched.query !== trimmed) return [];
  return fetched.rows;
}
