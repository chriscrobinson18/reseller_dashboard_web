import { useState, type FormEvent } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import Modal, { Field, inputCls, ModalActions } from '../Modal'
import { updateItem } from '../../lib/mutations'
import type { ItemWithLots } from '../../lib/queries'

interface Props {
  open: boolean
  onClose: () => void
  item: ItemWithLots
}

export default function EditItemModal({ open, onClose, item }: Props) {
  const qc = useQueryClient()
  const [name, setName] = useState(item.name)
  const [category, setCategory] = useState(item.category ?? '')
  const [error, setError] = useState<string | null>(null)

  const mutation = useMutation({
    mutationFn: () => updateItem(item.id, name.trim(), category.trim() || null),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['items'] }); onClose() },
    onError: (e: Error) => setError(e.message),
  })

  function submit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    if (!name.trim()) { setError('Name is required'); return }
    mutation.mutate()
  }

  return (
    <Modal open={open} onClose={onClose} title="Edit Item">
      <form onSubmit={submit}>
        <Field label="Name">
          <input autoFocus value={name} onChange={e => setName(e.target.value)} className={inputCls} />
        </Field>
        <Field label="Category" hint="Optional">
          <input value={category} onChange={e => setCategory(e.target.value)} className={inputCls} />
        </Field>
        {error && <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>}
        <ModalActions onCancel={onClose} submitLabel="Save Changes" loading={mutation.isPending} />
      </form>
    </Modal>
  )
}
