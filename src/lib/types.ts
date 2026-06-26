export interface Transaction {
  id: string
  user_id: string
  plaid_transaction_id?: string
  date: string // 'yyyy-MM-dd'
  amount: number // negative = expense, positive = income
  gross_amount?: number
  merchant?: string
  type?: string
  source: 'plaid' | 'manual' | 'csv_import'
  platform?: string
  record_type: 'transaction' | 'settlement'
  account_display?: string
  schedule_c_category?: string
  notes?: string
  net_zero_pair_id?: string
  related_sale_id?: string
  parent_settlement_id?: string
  csv_transaction_id?: string
  receipt_url?: string
  plaid_category?: string
  created_at: string
  is_non_cash: boolean
  // ── Plaid metadata (populated by plaid_sync_transactions v32+; null when source ≠ 'plaid'). ──
  merchant_logo_url?: string | null
  merchant_website?: string | null
  merchant_entity_id?: string | null
  location_city?: string | null
  location_region?: string | null
  location_store_number?: string | null
  payment_channel?: 'online' | 'in store' | 'other' | string | null
  authorized_date?: string | null
  iso_currency_code?: string | null
  pending?: boolean
  pending_plaid_transaction_id?: string | null
  plaid_category_detailed?: string | null
  plaid_category_confidence?: 'LOW' | 'MEDIUM' | 'HIGH' | 'VERY_HIGH' | string | null
  plaid_metadata?: Record<string, unknown> | null
  trade_id?: string
}

export interface Sale {
  id: string
  user_id: string
  item_id?: string
  platform?: string
  source: 'manual' | 'csv_import' | 'plaid' | 'trade'
  quantity: number
  sale_price: number
  fees: number
  shipping_cost?: number
  net_payout?: number
  external_order_id?: string
  inventory_status: 'ok' | 'oversold' | 'reconciled'
  return_status: 'none' | 'partial' | 'full'
  refunded_quantity: number
  refunded_amount?: number
  trade_id?: string
  sold_at: string
  created_at: string
  deleted_at?: string
  // from joins
  items?: { id: string; name: string; category?: string } | null
  inventory_movements?: Array<{
    id: string
    quantity: number
    inventory_lots: { unit_cost: number; item_id: string } | null
  }>
}

export interface Item {
  id: string
  user_id: string
  name: string
  category?: string
  created_at: string
  deleted_at?: string
  inventory_lots?: InventoryLot[]
}

export interface InventoryLot {
  id: string
  user_id: string
  item_id: string
  transaction_id?: string
  trade_id?: string
  quantity_purchased: number
  quantity_remaining: number
  unit_cost: number
  created_at: string
  deleted_at?: string
}

export interface Trade {
  id: string
  user_id: string
  created_at: string
  deleted_at?: string
  traded_at: string                          // 'yyyy-MM-dd'
  counterparty?: string
  given_fmv: number
  received_fmv: number
  cash_boot: number                          // signed; + you received, − you paid, 0 pure swap
  cash_transaction_id: string | null
  income_transaction_id: string | null
  cogs_transaction_id: string | null
  fmv_source_notes?: string
  notes?: string
}

export interface PlaidItem {
  id: string
  user_id: string | null
  item_id: string
  access_token: string
  institution_name: string | null
  institution_id: string | null
  last_synced_at: string | null
  cursor: string | null
  transactions_cursor: string | null
  created_at: string | null
  /** Added by the plaid_item_status migration. Treat absent column as 'active'. */
  status?: 'active' | 'login_required' | 'error'
  error_message?: string | null
}

export interface PlaidAccount {
  id: string
  user_id: string | null
  item_id: string
  account_id: string
  name: string | null
  mask: string | null
  subtype: string | null
  display_name: string | null
  sync_enabled: boolean
  created_at: string | null
}
