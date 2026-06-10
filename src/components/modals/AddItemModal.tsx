import { useState, type FormEvent } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import Modal, { Field, inputCls, ModalActions } from '../Modal'
import { createItem } from '../../lib/mutations'

export default function AddItemModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient()
  const [name, setName] = useState('')
  const [category, setCategory] = useState('')
  const [error, setError] = useState<string | null>(null)

  const mutation = useMutation({
    mutationFn: () => createItem(name.trim(), category.trim() || null),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['items'] })
      reset()
      onClose()
    },
    onError: (e: Error) => setError(e.message),
  })

  function reset() {
    setName(''); setCategory(''); setError(null)
  }

  function submit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    if (!name.trim()) { setError('Name is required'); return }
    mutation.mutate()
  }

  return (
    <Modal open={open} onClose={() => { reset(); onClose() }} title="Add Inventory Item">
      <form onSubmit={submit}>
        <Field label="Name">
          <input autoFocus value={name} onChange={e => setName(e.target.value)} className={inputCls} placeholder="e.g. LEGO Star Wars Set" />
        </Field>
        <Field label="Category" hint="Optional — e.g. LEGO, Trading Cards, Sneakers">
          <input value={category} onChange={e => setCategory(e.target.value)} className={inputCls} placeholder="Category" />
        </Field>
        {error && <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>}
        <ModalActions onCancel={() => { reset(); onClose() }} submitLabel="Add Item" loading={mutation.isPending} />
      </form>
    </Modal>
  )
}
