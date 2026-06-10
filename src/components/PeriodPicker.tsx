import { PERIOD_LABELS, PERIOD_PRESETS, type PeriodPreset } from '../lib/periods'

interface Props {
  value: PeriodPreset
  onChange: (p: PeriodPreset) => void
}

export default function PeriodPicker({ value, onChange }: Props) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {PERIOD_PRESETS.map(p => (
        <button
          key={p}
          onClick={() => onChange(p)}
          className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
            value === p
              ? 'bg-gray-900 text-white'
              : 'bg-white border border-gray-200 text-gray-600 hover:border-gray-400'
          }`}
        >
          {PERIOD_LABELS[p]}
        </button>
      ))}
    </div>
  )
}
