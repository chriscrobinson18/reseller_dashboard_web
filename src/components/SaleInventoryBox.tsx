import { useMemo, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Package, Check, Link2, RotateCcw } from 'lucide-react'
import { useItems, itemUnitsInStock } from '../lib/queries'
import { linkSaleToItem, resolveSaleRefund } from '../lib/mutations'
import { saleInventoryState, suggestItems, looksLikeSingleCard } from '../lib/saleInventory'
import { formatUSD } from '../lib/utils'
import type { Sale } from '../lib/types'

/**
 * Sale panel "Inventory" box: shows what the sale did to inventory and asks
 * "what happened to the item?" for refunds, then runs the matching action.
 * See src/lib/saleInventory.ts and docs/features/sales.md.
 */
export default function SaleInventoryBox({ sale, onChooseItem, onProcessReturn }: {
  sale: Sale
  /** Opens the full item picker (LinkSaleToItemModal). */
  onChooseItem: () => void
  /** Opens Process / Edit Return. */
  onProcessReturn: () => void
}) {
  const qc = useQueryClient()
  const state = saleInventoryState(sale)
  const [expanded, setExpanded] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const wantsSuggestions = state.kind === 'needs_link'
    || ((state.kind === 'refund_not_out' || (state.kind === 'partial' && state.units === 0)) && expanded)
  const { data: items = [] } = useItems()
  const title = sale.items?.name ?? sale.item_name ?? ''
  const suggestions = useMemo(
    () => (wantsSuggestions ? suggestItems(title, items) : []),
    [wantsSuggestions, title, items],
  )

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['sales'] })
    qc.invalidateQueries({ queryKey: ['items'] })
    qc.invalidateQueries({ queryKey: ['linked-records'] })
  }
  // Ordinary sale: link_sale_to_item. Fully refunded sale: resolve_sale_refund
  // ('kept'), which also clears any return recorded by mistake. Both take the
  // oldest units first.
  const refunded = sale.return_status === 'full'
  const link = useMutation({
    mutationFn: async (itemId: string | null) => {
      if (refunded) {
        const r = await resolveSaleRefund(sale.id, 'kept', itemId)
        return { consumed: r.units_taken ?? 0, unfulfilled: r.unfulfilled ?? 0 }
      }
      return linkSaleToItem(sale.id, itemId!)
    },
    onSuccess: r => {
      setErr(null)
      setMsg(r.unfulfilled > 0 ? `Linked: ${r.consumed} unit(s) taken; ${r.unfulfilled} not in stock (oversold).` : `${r.consumed} unit(s) taken from inventory.`)
      invalidate()
    },
    onError: (e: Error) => setErr(e.message),
  })
  // Came back / never shipped: resolve_sale_refund('back') puts every unit back
  // on its lot and records the return once, whatever the sale's history.
  const restore = useMutation({
    mutationFn: () => resolveSaleRefund(sale.id, 'back'),
    onSuccess: r => { setErr(null); setMsg(`${r.units_restored ?? 0} unit(s) put back in inventory. Refund unchanged.`); invalidate() },
    onError: (e: Error) => setErr(e.message),
  })
  const busy = link.isPending || restore.isPending

  const single = looksLikeSingleCard(title)
  const suggestionsList = (
    <div className="space-y-1.5">
      {single ? (
        <div className="text-gray-600">
          Looks like a <b>single card</b>: link it to the card's own item, created when you break down the box it came from (<a href="/breakdowns" className="text-blue-600 hover:underline">Breakdowns</a>), not to the sealed product.
        </div>
      ) : suggestions.length > 0 ? (
        <div className="text-gray-500">Suggested item{suggestions.length > 1 ? 's' : ''}:</div>
      ) : (
        <div className="text-gray-500">
          No matching item found. If you bought it, its purchase may have no lot yet: add the lot from the charge in Expenses, or run <code>/add-cogs-lots</code>.
        </div>
      )}
      {suggestions.map(({ item }) => (
        <div key={item.id} className="flex items-center gap-2 border border-gray-200 rounded-lg px-2 py-1.5 bg-white">
          <span className="truncate font-medium text-gray-800">{item.name}</span>
          <span className="text-gray-400 shrink-0">{itemUnitsInStock(item)} on hand</span>
          <button type="button" disabled={busy} onClick={() => link.mutate(item.id)}
            className="ml-auto shrink-0 px-2.5 py-1 rounded-md bg-gray-900 text-white font-medium disabled:opacity-50">
            Link
          </button>
        </div>
      ))}
      <button type="button" onClick={onChooseItem} className="text-blue-600 hover:text-blue-800 font-medium">
        {suggestions.length ? 'Choose a different item…' : 'Choose an item…'}
      </button>
    </div>
  )

  if (state.kind === 'trade') return null

  let tone = 'border-gray-200 bg-gray-50'
  let body: React.ReactNode = null
  switch (state.kind) {
    case 'linked':
      body = (
        <div className="flex items-center gap-1.5 text-gray-700">
          <Check size={13} className="text-emerald-600" />
          {state.units} unit{state.units === 1 ? '' : 's'} taken from inventory
          {state.units < sale.quantity && <span className="text-amber-700"> · {sale.quantity - state.units} not covered (oversold)</span>}
        </div>
      )
      break
    case 'needs_link':
      tone = 'border-amber-300 bg-amber-50'
      body = (
        <div className="space-y-2">
          <div className="text-amber-800">Not linked: the {sale.quantity > 1 ? `${sale.quantity} units still count` : 'unit still counts'} as on hand and cost of goods is missing.</div>
          {suggestionsList}
        </div>
      )
      break
    case 'refund_not_out':
      body = (
        <div className="space-y-2">
          <div className="text-gray-700">
            Refunded {formatUSD(state.refunded)}. <b>Nothing left inventory</b>: right if the item <b>came back</b> or <b>never shipped</b>.
          </div>
          {!expanded ? (
            <button type="button" onClick={() => setExpanded(true)} className="text-blue-600 hover:text-blue-800 font-medium">
              Buyer kept it or it was lost? Take it out of inventory…
            </button>
          ) : sale.item_id ? (
            <div className="space-y-1.5">
              <div className="text-gray-500">The unit is gone, so its cost counts.</div>
              <button type="button" disabled={busy} onClick={() => link.mutate(null)}
                className="px-2.5 py-1 rounded-md bg-gray-900 text-white font-medium disabled:opacity-50">
                Take {sale.quantity === 1 ? 'it' : `${sale.quantity} units`} from {sale.items?.name ? `“${sale.items.name.slice(0, 40)}”` : 'its item'}
              </button>
              <button type="button" onClick={onChooseItem} className="block text-blue-600 hover:text-blue-800 font-medium">Choose a different item…</button>
            </div>
          ) : (
            <>
              <div className="text-gray-500">The unit is gone, so its cost counts. Link the item it came from:</div>
              {suggestionsList}
            </>
          )}
        </div>
      )
      break
    case 'refund_out':
      tone = 'border-gray-200 bg-gray-50'
      body = (
        <div className="space-y-2">
          <div className="text-gray-700">
            Refunded {formatUSD(state.refunded)}. <b>{state.units} unit{state.units === 1 ? '' : 's'} counted as gone</b>: right if the buyer <b>kept it</b> or it was <b>lost</b>.
          </div>
          <button type="button" disabled={busy} onClick={() => restore.mutate()}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-gray-300 bg-white font-medium text-gray-700 hover:border-gray-500 disabled:opacity-50">
            <RotateCcw size={12} /> It came back / never shipped: put {state.units === 1 ? 'it' : `${state.units} units`} back in inventory
          </button>
        </div>
      )
      break
    case 'partial':
      body = (
        <div className="space-y-2">
          <div className="text-gray-700">
            Partly refunded {formatUSD(state.refunded)} · {state.units} unit{state.units === 1 ? '' : 's'} out{state.returnedUnits ? ` · ${state.returnedUnits} returned` : ''}.
          </div>
          <div className="flex flex-col items-start gap-1.5">
            <button type="button" onClick={onProcessReturn} className="text-blue-600 hover:text-blue-800 font-medium">
              Some units came back? Record them…
            </button>
            {state.units === 0 && !expanded && (
              <button type="button" onClick={() => setExpanded(true)} className="text-blue-600 hover:text-blue-800 font-medium">
                No units came back (a partial refund)? Link to inventory…
              </button>
            )}
          </div>
          {state.units === 0 && expanded && suggestionsList}
        </div>
      )
      break
  }

  return (
    <div className={`border rounded-xl p-3 text-xs ${tone}`}>
      <div className="flex items-center gap-1.5 font-semibold text-gray-500 uppercase tracking-wide text-[11px] mb-1.5">
        <Package size={12} /> Inventory
      </div>
      {body}
      {msg && <div className="mt-2 text-emerald-700 flex items-center gap-1"><Link2 size={12} /> {msg}</div>}
      {err && <div className="mt-2 text-red-600">{err}</div>}
    </div>
  )
}
