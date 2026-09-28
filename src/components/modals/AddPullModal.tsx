import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import Modal, { Field, inputCls, ModalActions } from '../Modal'
import ItemPicker from '../ItemPicker'
import { addPullToOpening } from '../../lib/mutations'
import { formatUSD } from '../../lib/utils'

interface Props {
  open: boolean
  onClose: () => void
  boxOpeningId: string
  remainingBasis: number
  onPullAdded: (lotId: string) => void
}

export default function AddPullModal({ open, onClose, boxOpeningId, remainingBasis, onPullAdded }: Props) {
  const qc = useQueryClient()
  const [itemId, setItemId] = useState<string | null>(null)
  const [isNew, setIsNew] = useState(false)
  const [newItemName, setNewItemName] = useState('')
  const [basis, setBasis] = useState('')

  const mutation = useMutation({
    mutationFn: () =>
      addPullToOpening({
        boxOpeningId,
        itemId: isNew ? null : itemId,
        newItemName: isNew ? newItemName : null,
        basis: parseFloat(basis),
      }),
    onSuccess: ({ lotId }) => {
      qc.invalidateQueries({ queryKey: ['items'] })
      qc.invalidateQueries({ queryKey: ['box-opening'] })
      qc.invalidateQueries({ queryKey: ['box-openings'] })
      onPullAdded(lotId)
      handleClose()
    },
  })

  function handleClose() {
    setItemId(null)
    setIsNew(false)
    setNewItemName('')
    setBasis('')
    mutation.reset()
    onClose()
  }

  const basisNum = parseFloat(basis)
  const hasItem = isNew ? newItemName.trim().length > 0 : !!itemId
  const valid = hasItem && !isNaN(basisNum) && basisNum > 0 && basisNum <= remainingBasis + 0.01

  return (
    <Modal open={open} onClose={handleClose} title="Add Pull">
      <form onSubmit={e => { e.preventDefault(); mutation.mutate() }} className="space-y-4 p-4">
        <Field label="Item">
          {isNew ? (
            <div className="space-y-2">
              <input
                autoFocus
                className={inputCls}
                placeholder="Card name"
                value={newItemName}
                onChange={e => setNewItemName(e.target.value)}
              />
              <button
                type="button"
                className="text-xs text-blue-600 hover:underline"
                onClick={() => { setIsNew(false); setNewItemName('') }}
              >
                ← Pick existing item
              </button>
            </div>
          ) : (
            <ItemPicker
              selectedId={itemId}
              onSelect={item => setItemId(item.id)}
              onCreateNew={() => setIsNew(true)}
            />
          )}
        </Field>

        <Field
          label="Basis"
          hint={`${formatUSD(remainingBasis)} remaining in pool`}
        >
          <div className="relative">
            <span className="absolute left-3 top-2 text-sm text-gray-500">$</span>
            <input
              className={`${inputCls} pl-6`}
              type="number"
              min="0.01"
              step="0.01"
              max={remainingBasis}
              placeholder="0.00"
              value={basis}
              onChange={e => setBasis(e.target.value)}
            />
          </div>
        </Field>

        {mutation.isError && (
          <p className="text-xs text-red-600">{(mutation.error as Error).message}</p>
        )}

        <ModalActions onCancel={handleClose} submitLabel="Add Pull" loading={mutation.isPending} disabled={!valid} />
      </form>
    </Modal>
  )
}
