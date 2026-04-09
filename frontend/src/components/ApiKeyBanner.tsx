import { useState } from 'react'
import { Eye, EyeOff, X } from 'lucide-react'
import { setApiKey } from '../api'

interface Props {
  onDismiss: () => void
}

export default function ApiKeyBanner({ onDismiss }: Props) {
  const [expanded, setExpanded] = useState(false)
  const [keyValue, setKeyValue] = useState('')
  const [showKey, setShowKey] = useState(false)

  const handleSave = () => {
    if (keyValue.trim()) {
      setApiKey(keyValue.trim())
      onDismiss()
    }
  }

  return (
    <div className="bg-warning/10 border-b border-warning/30 px-4 py-2 flex-shrink-0">
      {expanded ? (
        <div className="flex items-center gap-2 max-w-2xl mx-auto">
          <div className="relative flex-1">
            <input
              type={showKey ? 'text' : 'password'}
              value={keyValue}
              onChange={e => setKeyValue(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleSave() }}
              placeholder="sk-ant-... or sk-or-..."
              autoFocus
              className="w-full text-sm bg-background border border-border rounded-md px-3 py-1.5 pr-8 text-foreground font-mono focus:outline-none focus:ring-1 focus:ring-accent"
            />
            <button
              type="button"
              onClick={() => setShowKey(!showKey)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              {showKey ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
            </button>
          </div>
          <button
            onClick={handleSave}
            disabled={!keyValue.trim()}
            className="px-3 py-1.5 text-xs font-medium bg-accent text-accent-foreground rounded-md hover:opacity-90 transition-opacity disabled:opacity-40"
          >
            Save
          </button>
          <button
            onClick={() => setExpanded(false)}
            className="text-muted-foreground hover:text-foreground"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      ) : (
        <div className="flex items-center justify-center gap-3 text-sm">
          <span className="text-warning font-medium">No API key configured</span>
          <button
            onClick={() => setExpanded(true)}
            className="px-3 py-1 text-xs font-medium bg-accent text-accent-foreground rounded-md hover:opacity-90 transition-opacity"
          >
            Add now
          </button>
        </div>
      )}
    </div>
  )
}
