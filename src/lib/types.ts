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
