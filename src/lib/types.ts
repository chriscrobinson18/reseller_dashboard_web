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
  /** Set on the payout/fee/shipping transactions auto-created by a bundle sale — see SaleBundle. */
  related_bundle_id?: string
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
  item_name?: string | null
  platform?: string
  source: 'manual' | 'csv_import' | 'plaid' | 'trade'
  quantity: number
  sale_price: number
  fees: number
  shipping_cost?: number
  net_payout?: number
  external_order_id?: string
  /** How the buyer paid — see lib/paymentMethods.ts. Orthogonal to `platform`. */
  payment_method?: string | null
  /**
   * Client-side only, never persisted. A bundle line's share of its bundle's
   * order-level fees/shipping, allocated proportionally by line price.
   *
   * Kept separate from `fees`/`shipping_cost` rather than overwriting them: those
   * are genuinely 0 on a bundle line (the real charge lives once on the bundle),
   * and `EditSaleModal` seeds its form from them — overwriting would silently
   * persist an allocated share onto the line the first time someone edits it.
   */
  allocated_fees?: number
  allocated_shipping?: number
  inventory_status: 'ok' | 'oversold' | 'reconciled'
  return_status: 'none' | 'partial' | 'full'
  refunded_quantity: number
  refunded_amount?: number
  trade_id?: string
  /** Set when this line is part of a multi-item bundle sale — see SaleBundle. */
  bundle_id?: string
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

/**
 * One sale event that disposes of several DIFFERENT inventory items for one
 * combined payout. Each item becomes its own `sales` row (source='manual',
 * `bundle_id` = this row's id) carrying its own user-entered price, so
 * per-item profit works unmodified. fees/shipping/payment_method live here,
 * not on the lines, because they're one number for the whole order — see the
 * migration comment in sale_bundles.sql for why.
 */
export interface SaleBundle {
  id: string
  user_id: string
  created_at: string
  deleted_at?: string
  sold_at: string // 'yyyy-MM-dd'
  platform?: string | null
  payment_method?: string | null
  external_order_id?: string | null
  fees: number
  shipping_cost?: number | null
  notes?: string | null
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

/**
 * One funding link between a lot and a transaction that paid for it.
 * A split-tender purchase produces several of these for the same lot.
 */
export interface InventoryLotTransaction {
  id: string
  user_id: string
  lot_id: string
  transaction_id: string
  /** Unsigned magnitude this transaction contributed to the lot's cost. */
  allocated_amount: number
  created_at: string
}

export type LotAdjustmentType = 'grading' | 'shipping_to_grader' | 'other'

/**
 * A cost added to a lot after creation and capitalized into its basis —
 * grading a card, shipping it to the grader. See `basisFromAdjustments` in
 * lib/lotCost.ts for how these roll into the lot's `unit_cost`.
 */
export interface LotCostAdjustment {
  id: string
  user_id: string
  lot_id: string
  transaction_id?: string | null
  /**
   * True when this adjustment posted its own cost_of_goods transaction. Only
   * those may be deleted along with the adjustment — a transaction that was
   * merely *linked* (a Plaid-synced PSA charge) is real financial history.
   */
  created_transaction: boolean
  adjustment_type: LotAdjustmentType
  /** Positive dollars. Basis increases only; negative adjustments are out of scope. */
  amount: number
  incurred_on: string // 'yyyy-MM-dd'
  grader?: string | null
  grade_received?: string | null
  notes?: string | null
  created_at: string
  deleted_at?: string | null
}

export interface InventoryLot {
  id: string
  user_id: string
  item_id: string
  /** Mirrors the primary link in `inventory_lot_transactions`; kept for iOS. */
  transaction_id?: string
  /** All funding links. Source of truth for the web client. */
  inventory_lot_transactions?: InventoryLotTransaction[]
  trade_id?: string
  /** Set when this lot is a single card that came from opening a sealed box. */
  box_opening_id?: string | null
  quantity_purchased: number
  quantity_remaining: number
  /** All-in current basis per unit, adjustments included. */
  unit_cost: number
  /** Per-unit basis before any adjustments; null on lots predating the column. */
  initial_unit_cost?: number | null
  /** Active (non-soft-deleted) capitalized costs behind `unit_cost`. */
  lot_cost_adjustments?: LotCostAdjustment[]
  purchase_date?: string | null
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

export type BoxAllocationMethod = 'relative_fmv' | 'specific_id' | 'equal'

/**
 * Audit-trail row for one sealed-box-opening event. The resulting cards are
 * ordinary `inventory_lots` rows (`quantity_purchased = 1` each) tagged with
 * `box_opening_id` — see `docs/superpowers/specs/2026-06-23-box-opening-and-grading-design.md`.
 */
export interface BoxOpening {
  id: string
  user_id: string
  created_at: string
  deleted_at?: string | null
  opened_at: string                          // 'yyyy-MM-dd'
  box_name: string
  box_cost: number | null
  /** Mirrors the source lot's purchase transaction, if any — display only; no transaction is created by opening. */
  transaction_id: string | null
  allocation_method: BoxAllocationMethod | null
  /** The inventory_lots row this box was opened from — an existing item already in inventory. */
  source_lot_id: string | null
  /** How many units of the source lot were opened (usually 1). */
  quantity: number
  notes?: string | null
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
