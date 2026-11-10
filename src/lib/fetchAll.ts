/**
 * Fetch every row of a query, page by page.
 *
 * Supabase (PostgREST) caps each response at the project's `max_rows`
 * (1000 here) and does so SILENTLY: `.limit(5000)` still returns at most
 * 1000 rows with no error. A tax year has more transactions than that
 * (found 2026-11-10: 2025 had 2,137, so year views saw under half of them).
 *
 * `page(from, to)` must return the query with `.range(from, to)` applied and
 * a deterministic order (end with a unique column such as `id`), otherwise
 * rows can repeat or be skipped between pages.
 *
 * Paging stops at the first EMPTY page, not at the first short page, so it
 * stays correct even if the server cap is lower than `pageSize`.
 */
export async function fetchAllRows<T>(
  page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>,
  pageSize = 1000,
  maxRows = 200_000,
): Promise<T[]> {
  const out: T[] = []
  for (;;) {
    const { data, error } = await page(out.length, out.length + pageSize - 1)
    if (error) throw error
    if (!data || data.length === 0) return out
    out.push(...data)
    if (out.length >= maxRows) throw new Error(`fetchAllRows: more than ${maxRows} rows; narrow the query`)
  }
}
