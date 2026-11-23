import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import Modal, { ModalActions } from '../Modal'
import ItemPicker from '../ItemPicker'
import { linkSaleToItem } from '../../lib/mutations'
import type { ItemWithLots } from '../../lib/queries'
import type { Sale } from '../../lib/types'

interface Props {
  open: boolean
  onClose: () => void
  sale: Sale
}

export default function LinkSaleToItemModal({ open, onClose, sale }: Props) {
  const qc = useQueryClient()
  // A sale linked before 2026-11-12 has item_id but no lot units taken;
  // start from that item so relinking it is one click.
  const [itemId, setItemId] = useState<string | null>(sale.item_id ?? null)
  const [error, setError] = useState<string | null>(null)

  const mutation = useMutation({
    mutationFn: () => linkSaleToItem(sale.id, itemId!),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sales'] })
      qc.invalidateQueries({ queryKey: ['items'] })
      setItemId(null)
      onClose()
    },
    onError: (e: Error) => setError(e.message),
  })

  return (
    <Modal open={open} onClose={() => { setItemId(null); onClose() }} title="Link Sale to Inventory Item">
      <form onSubmit={e => { e.preventDefault(); if (itemId) mutation.mutate() }}>
        <div className="bg-gray-50 rounded-lg p-3 mb-4 text-xs">
          <div className="text-gray-400 mb-0.5">Sale</div>
          <div className="text-gray-800 font-medium">
            {sale.platform} · {sale.quantity} unit{sale.quantity > 1 ? 's' : ''} · ${sale.sale_price}
          </div>
          {sale.external_order_id && <div className="text-gray-400 mt-0.5">Order {sale.external_order_id}</div>}
        </div>

        <div className="mb-2 text-xs font-medium text-gray-700">Choose the inventory item this sale is for:</div>
        <ItemPicker selectedId={itemId} onSelect={(i: ItemWithLots) => setItemId(i.id)} />

        <p className="text-xs text-gray-400 mt-3">
          Linking assigns the item and takes the units from its inventory lots, oldest purchase first (lots bought on
          or before the sale date are used first). If there aren&apos;t enough units left, the sale is marked oversold.
        </p>

        {error && <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2 mt-2">{error}</div>}
        <ModalActions
          onCancel={() => { setItemId(null); onClose() }}
          submitLabel="Link Item"
          loading={mutation.isPending}
          disabled={!itemId}
        />
      </form>
    </Modal>
  )
}
