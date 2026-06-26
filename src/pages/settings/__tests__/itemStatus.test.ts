import { describe, it, expect } from 'vitest'
import type { PlaidItem } from '../../../lib/types'
import { getItemStatus } from '../itemStatus'

function item(over: Partial<PlaidItem> = {}): PlaidItem {
  return {
    id: 'x',
    user_id: 'u',
    item_id: 'plaid-x',
    access_token: 'a',
    institution_name: 'Test Bank',
    institution_id: null,
    last_synced_at: null,
    cursor: null,
    transactions_cursor: null,
    created_at: null,
    ...over,
  }
}

describe('getItemStatus', () => {
  it('returns "syncing" when the mutation is in flight, regardless of persisted status', () => {
    expect(getItemStatus(item({ status: 'login_required' }), true)).toBe('syncing')
  })

  it('returns "reconnect" when status is login_required and not syncing', () => {
    expect(getItemStatus(item({ status: 'login_required' }), false)).toBe('reconnect')
  })

  it('returns "error" when status is error', () => {
    expect(getItemStatus(item({ status: 'error' }), false)).toBe('error')
  })

  it('returns "connected" when status is active', () => {
    expect(getItemStatus(item({ status: 'active' }), false)).toBe('connected')
  })

  it('treats absent status (pre-migration) as connected', () => {
    expect(getItemStatus(item(), false)).toBe('connected')
  })
})
