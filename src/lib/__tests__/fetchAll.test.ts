import { describe, it, expect } from 'vitest'
import { fetchAllRows } from '../fetchAll'

/** Fake PostgREST: serves `rows` for range(from, to), capped at `cap` per response. */
function server(rows: number[], cap: number) {
  const calls: Array<[number, number]> = []
  const page = async (from: number, to: number) => {
    calls.push([from, to])
    return { data: rows.slice(from, Math.min(to + 1, from + cap)), error: null }
  }
  return { page, calls }
}
const range = (n: number) => Array.from({ length: n }, (_, i) => i)

describe('fetchAllRows', () => {
  it('returns every row past the 1000-row server cap (regression: 2,137 rows came back as 1,000)', async () => {
    const s = server(range(2137), 1000)
    const out = await fetchAllRows(s.page)
    expect(out).toEqual(range(2137))
    expect(s.calls).toEqual([[0, 999], [1000, 1999], [2000, 2999], [2137, 3136]])
  })

  it('stays correct when the server cap is lower than the page size', async () => {
    const s = server(range(450), 100)
    expect(await fetchAllRows(s.page, 1000)).toEqual(range(450))
  })

  it('handles an exact multiple of the page size and an empty result', async () => {
    expect(await fetchAllRows(server(range(2000), 1000).page)).toHaveLength(2000)
    expect(await fetchAllRows(server([], 1000).page)).toEqual([])
  })

  it('treats a null data page as the end', async () => {
    expect(await fetchAllRows(async () => ({ data: null, error: null }))).toEqual([])
  })

  it('throws the query error', async () => {
    const err = { message: 'boom' }
    await expect(fetchAllRows(async () => ({ data: null, error: err }))).rejects.toBe(err)
  })

  it('refuses to run away past maxRows', async () => {
    await expect(fetchAllRows(async () => ({ data: [1, 2, 3], error: null }), 3, 9)).rejects.toThrow(/more than 9 rows/)
  })
})
