import { useState, useMemo, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, Pencil, Trash2 } from 'lucide-react'
import Modal, { Field, inputCls, ModalActions } from '../Modal'
import ConfirmDialog from '../ConfirmDialog'
import CategoryBadge from '../CategoryBadge'
import { CATEGORIES, type CustomCategory } from '../../lib/categories'
import { PALETTE, PALETTE_KEYS, type ColorKey } from '../../lib/categoryPalette'
import { useCustomCategories } from '../../lib/queries'
import {
  createCustomCategory,
  updateCustomCategory,
  deleteCustomCategory,
  countTransactionsUsingCustomCategory,
} from '../../lib/mutations'

type Mode = 'list' | 'create' | { mode: 'edit'; id: string }
type Mapping = 'parent' | 'line'

// Allowed Schedule C lines for the explicit-mapping picker. Line 24b is intentionally
// excluded — users wanting a Line 24b custom must go via parent_value='meals' so the
// 50% meals deduction is inherited.
const SCHEDULE_LINES: string[] = (() => {
  const lines = new Set<string>(['Part I', 'Part III'])
  for (const c of CATEGORIES) {
    if (c.scheduleLine?.startsWith('Line ') && c.scheduleLine !== 'Line 24b') {
      lines.add(c.scheduleLine)
    }
  }
  return Array.from(lines)
})()

export default function ManageCategoriesModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { data: customs = [] } = useCustomCategories()
  const [mode, setMode] = useState<Mode>('list')

  const active = useMemo(() => customs.filter(c => !c.deletedAt), [customs])
  const editing = useMemo(() => {
    if (typeof mode === 'object' && mode.mode === 'edit') {
      return active.find(c => c.id === mode.id) ?? null
    }
    return null
  }, [mode, active])

  function close() {
    setMode('list')
    onClose()
  }

  return (
    <Modal open={open} onClose={close} title="Manage categories">
      <div className="space-y-4">
        {mode === 'list' && (
          <>
            <button
              type="button"
              onClick={() => setMode('create')}
              className="flex items-center gap-1.5 bg-gray-900 text-white px-3 py-1.5 rounded-lg text-sm font-medium hover:bg-gray-700 transition-colors"
            >
              <Plus size={14} /> New category
            </button>

            {active.length === 0 ? (
              <p className="text-sm text-gray-500">
                No custom categories yet. Click <em>New category</em> to create one for things like
                "Stripe Fees" or a line item that isn't in the built-in list.
              </p>
            ) : (
              <div>
                <div className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2">
                  Your categories
                </div>
                <ul className="space-y-1">
                  {active.map(c => (
                    <CategoryRow key={c.id} c={c} onEdit={() => setMode({ mode: 'edit', id: c.id })} />
                  ))}
                </ul>
              </div>
            )}

            <div>
              <div className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2">
                Built-in (read-only)
              </div>
              <ul className="space-y-1">
                {CATEGORIES.filter(c => !c.isExcluded).map(c => (
                  <li key={c.value} className="flex items-center gap-2 text-xs text-gray-600 py-1">
                    <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: c.color }} />
                    <span>{c.label}</span>
                    {c.scheduleLine && <span className="ml-auto text-gray-400">{c.scheduleLine}</span>}
                  </li>
                ))}
              </ul>
            </div>

            <ModalActions onCancel={close} submitLabel="Done" />
          </>
        )}

        {(mode === 'create' || editing) && (
          <CategoryForm
            initial={editing}
            onSaved={() => setMode('list')}
            onCancel={() => setMode('list')}
            onDeleted={() => setMode('list')}
          />
        )}
      </div>
    </Modal>
  )
}

function CategoryRow({ c, onEdit }: { c: CustomCategory; onEdit: () => void }) {
  const parentLabel = c.parentValue
    ? CATEGORIES.find(b => b.value === c.parentValue)?.label
    : null
  return (
    <li className="flex items-start gap-3 py-1.5">
      <div className="flex-1 min-w-0">
        <CategoryBadge value={c.value} />
        <div className="text-xs text-gray-400 mt-0.5">
          {c.parentValue
            ? <>parent: {parentLabel ?? c.parentValue}</>
            : <>{c.scheduleLine}</>}
        </div>
      </div>
      <span className="text-xs text-gray-500 ml-auto self-center">
        {c.parentValue
          ? CATEGORIES.find(b => b.value === c.parentValue)?.scheduleLine
          : c.scheduleLine}
      </span>
      <button
        type="button"
        onClick={onEdit}
        className="p-1 text-gray-400 hover:text-gray-700 transition-colors"
        aria-label="Edit"
      >
        <Pencil size={14} />
      </button>
    </li>
  )
}

function CategoryForm({
  initial,
  onSaved,
  onCancel,
  onDeleted,
}: {
  initial: CustomCategory | null
  onSaved: () => void
  onCancel: () => void
  onDeleted: () => void
}) {
  const qc = useQueryClient()
  const [name, setName] = useState(initial?.name ?? '')
  const [colorKey, setColorKey] = useState<ColorKey>(initial?.colorKey ?? 'emerald')
  const [mapping, setMapping] = useState<Mapping>(initial?.parentValue ? 'parent' : 'line')
  const [parentValue, setParentValue] = useState(initial?.parentValue ?? CATEGORIES.find(c => !c.isExcluded)!.value)
  const [scheduleLine, setScheduleLine] = useState(initial?.scheduleLine ?? 'Line 27a')
  const [error, setError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const showPartIIIWarning = mapping === 'line' && scheduleLine === 'Part III'

  const txCountQuery = useQuery({
    queryKey: ['custom_category_usage', initial?.id],
    enabled: !!initial && confirmDelete,
    queryFn: () => countTransactionsUsingCustomCategory(initial!.id),
  })

  const saveMutation = useMutation({
    mutationFn: async () => {
      const payload = {
        name,
        colorKey,
        parentValue: mapping === 'parent' ? parentValue : null,
        scheduleLine: mapping === 'line' ? scheduleLine : null,
      }
      if (initial) {
        await updateCustomCategory(initial.id, payload)
      } else {
        await createCustomCategory(payload)
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['custom_categories'] })
      qc.invalidateQueries({ queryKey: ['transactions'] })
      onSaved()
    },
    onError: (e: Error) => setError(e.message),
  })

  const deleteMutation = useMutation({
    mutationFn: () => deleteCustomCategory(initial!.id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['custom_categories'] })
      qc.invalidateQueries({ queryKey: ['transactions'] })
      onDeleted()
    },
    onError: (e: Error) => setError(e.message),
  })

  function submit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    saveMutation.mutate()
  }

  // Live preview is rendered inline below from form state — CategoryBadge can't
  // see in-flight form values because it pulls from the useCustomCategories cache,
  // and a synthetic cache write would race with React Query's lifecycle.
  const previewSwatch = PALETTE[colorKey]

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="text-sm font-semibold text-gray-900">
        {initial ? 'Edit category' : 'New category'}
      </div>

      <Field label="Name">
        <input
          autoFocus
          value={name}
          onChange={e => setName(e.target.value)}
          maxLength={40}
          className={inputCls}
          placeholder="e.g. Stripe Fees"
        />
        <div className="text-xs text-gray-400 text-right mt-0.5">{name.length}/40</div>
      </Field>

      <Field label="Color">
        <div className="grid grid-cols-6 gap-2">
          {PALETTE_KEYS.map(k => (
            <button
              key={k}
              type="button"
              onClick={() => setColorKey(k)}
              className={`h-8 rounded-lg border-2 transition-all ${
                colorKey === k ? 'border-gray-900 ring-2 ring-gray-300' : 'border-transparent'
              }`}
              style={{ backgroundColor: PALETTE[k].bgColor }}
              aria-label={k}
            >
              <span className="block w-3 h-3 rounded-full mx-auto" style={{ backgroundColor: PALETTE[k].color }} />
            </button>
          ))}
        </div>
      </Field>

      <Field label="Tax mapping">
        <div className="space-y-2">
          <label className="flex items-start gap-2 cursor-pointer">
            <input
              type="radio"
              checked={mapping === 'parent'}
              onChange={() => setMapping('parent')}
              className="mt-1"
            />
            <div className="flex-1">
              <div className="text-sm">Refine an existing category</div>
              {mapping === 'parent' && (
                <select
                  value={parentValue}
                  onChange={e => setParentValue(e.target.value)}
                  className={inputCls + ' bg-white mt-1'}
                >
                  {CATEGORIES.map(c => (
                    <option key={c.value} value={c.value}>
                      {c.label}{c.scheduleLine ? ` (${c.scheduleLine})` : ' (excluded)'}
                    </option>
                  ))}
                </select>
              )}
            </div>
          </label>

          <label className="flex items-start gap-2 cursor-pointer">
            <input
              type="radio"
              checked={mapping === 'line'}
              onChange={() => setMapping('line')}
              className="mt-1"
            />
            <div className="flex-1">
              <div className="text-sm">Map to a Schedule C line directly</div>
              {mapping === 'line' && (
                <>
                  <select
                    value={scheduleLine}
                    onChange={e => setScheduleLine(e.target.value)}
                    className={inputCls + ' bg-white mt-1'}
                  >
                    {SCHEDULE_LINES.map(l => <option key={l} value={l}>{l}</option>)}
                  </select>
                  {showPartIIIWarning && (
                    <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1.5 mt-1">
                      Part III is for inventory cost — most users won't need a custom there. Continue if you're sure.
                    </div>
                  )}
                </>
              )}
            </div>
          </label>
        </div>
      </Field>

      <div>
        <div className="text-xs font-medium text-gray-500 mb-1.5">Preview</div>
        <span
          className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium"
          style={{ color: previewSwatch.color, backgroundColor: previewSwatch.bgColor }}
        >
          {name.trim() || 'Preview'}
        </span>
      </div>

      {error && (
        <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>
      )}

      <div className="flex items-center justify-between">
        {initial ? (
          <button
            type="button"
            onClick={() => setConfirmDelete(true)}
            className="flex items-center gap-1 text-xs text-red-600 hover:text-red-800"
          >
            <Trash2 size={12} /> Delete
          </button>
        ) : <span />}
        <ModalActions
          onCancel={onCancel}
          submitLabel={initial ? 'Save changes' : 'Create category'}
          loading={saveMutation.isPending}
        />
      </div>

      <ConfirmDialog
        open={confirmDelete}
        title="Delete this category?"
        message={
          txCountQuery.isLoading
            ? 'Checking how many transactions reference it…'
            : (txCountQuery.data ?? 0) > 0
              ? `${txCountQuery.data} transaction${txCountQuery.data === 1 ? '' : 's'} use this category. They'll keep showing the tag with "(deleted)" until you recategorize them.`
              : 'This category isn\'t used by any transactions yet.'
        }
        loading={deleteMutation.isPending}
        onConfirm={() => deleteMutation.mutate()}
        onCancel={() => setConfirmDelete(false)}
      />
    </form>
  )
}
