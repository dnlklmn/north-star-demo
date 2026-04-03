import { useState, useEffect } from 'react'
import { Eye, EyeOff } from 'lucide-react'
import type { Settings } from '../types'
import { getSettings, updateSettings, getApiKey, setApiKey } from '../api'

interface SettingsPanelProps {
  onClose: () => void
}

type Tab = 'agent' | 'app'

const MODEL_OPTIONS = [
  { value: 'claude-sonnet-4-20250514', label: 'Claude Sonnet 4' },
  { value: 'claude-opus-4-20250514', label: 'Claude Opus 4' },
  { value: 'claude-haiku-4-20250514', label: 'Claude Haiku 4' },
]

const CREATIVITY_LABELS: Record<string, string> = {
  strict: 'Only includes criteria directly stated by the user. Empty sections are left empty.',
  balanced: 'Starts with user input, adds a few reasonable inferences per section.',
  creative: 'Expands broadly from user input. Fills all sections with best-guess criteria.',
}

function creativityBucket(value: number): string {
  if (value < 0.3) return 'strict'
  if (value < 0.6) return 'balanced'
  return 'creative'
}

export default function SettingsPanel({ onClose }: SettingsPanelProps) {
  const [tab, setTab] = useState<Tab>('agent')
  const [settings, setSettings] = useState<Settings | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'))
  const [apiKeyValue, setApiKeyValue] = useState(() => getApiKey())
  const [showKey, setShowKey] = useState(false)
  const [keySaved, setKeySaved] = useState(false)

  useEffect(() => {
    getSettings().then(setSettings).catch(() => setError('Failed to load settings'))
  }, [])

  function handleThemeChange(isDark: boolean) {
    setDark(isDark)
    document.documentElement.classList.toggle('dark', isDark)
  }

  async function handleChange(fields: Partial<Settings>) {
    if (!settings) return
    const updated = { ...settings, ...fields }
    setSettings(updated)
    setSaving(true)
    setError(null)
    try {
      const saved = await updateSettings(fields)
      setSettings(saved)
    } catch {
      setError('Failed to save')
    } finally {
      setSaving(false)
    }
  }

  const bucket = settings ? creativityBucket(settings.creativity) : 'strict'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-surface-raised border border-border rounded-xl shadow-xl w-full max-w-md mx-4">
        {/* Header with tabs */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-border">
          <div className="flex items-center gap-4">
            <button
              onClick={() => setTab('agent')}
              className={`text-sm font-medium transition-colors ${
                tab === 'agent' ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              Agent
            </button>
            <button
              onClick={() => setTab('app')}
              className={`text-sm font-medium transition-colors ${
                tab === 'app' ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              App
            </button>
          </div>
          <button
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground text-lg leading-none"
          >
            x
          </button>
        </div>

        <div className="p-5 space-y-5">
          {tab === 'agent' && (
            <>
              {!settings ? (
                <p className="text-sm text-muted-foreground">{error || 'Loading...'}</p>
              ) : (
                <>
                  {/* Model */}
                  <div>
                    <label className="text-xs font-medium text-foreground block mb-1.5">Model</label>
                    <select
                      value={settings.model_name}
                      onChange={e => handleChange({ model_name: e.target.value })}
                      className="w-full text-sm bg-surface border border-border rounded-lg px-3 py-2 text-foreground focus:outline-none focus:ring-1 focus:ring-accent"
                    >
                      {MODEL_OPTIONS.map(opt => (
                        <option key={opt.value} value={opt.value}>{opt.label}</option>
                      ))}
                    </select>
                    <p className="text-[10px] text-muted-foreground mt-1">
                      The Claude model used for all agent operations.
                    </p>
                  </div>

                  {/* Max question rounds */}
                  <div>
                    <label className="text-xs font-medium text-foreground block mb-1.5">
                      Max question rounds
                    </label>
                    <div className="flex items-center gap-3">
                      <input
                        type="range"
                        min={1}
                        max={10}
                        value={settings.max_rounds}
                        onChange={e => handleChange({ max_rounds: parseInt(e.target.value) })}
                        className="flex-1 accent-accent"
                      />
                      <span className="text-sm font-mono text-foreground w-6 text-right">
                        {settings.max_rounds}
                      </span>
                    </div>
                    <p className="text-[10px] text-muted-foreground mt-1">
                      How many rounds of questions the agent asks before offering to proceed.
                    </p>
                  </div>

                  {/* Creativity / Strictness */}
                  <div>
                    <label className="text-xs font-medium text-foreground block mb-1.5">
                      Creativity
                    </label>
                    <div className="flex items-center gap-3">
                      <span className="text-[10px] text-muted-foreground">Strict</span>
                      <input
                        type="range"
                        min={0}
                        max={100}
                        value={Math.round(settings.creativity * 100)}
                        onChange={e => handleChange({ creativity: parseInt(e.target.value) / 100 })}
                        className="flex-1 accent-accent"
                      />
                      <span className="text-[10px] text-muted-foreground">Creative</span>
                    </div>
                    <div className="mt-2 p-2.5 bg-surface rounded-lg border border-border">
                      <span className={`text-[10px] font-medium uppercase tracking-wide ${
                        bucket === 'strict' ? 'text-success' : bucket === 'balanced' ? 'text-warning' : 'text-accent'
                      }`}>
                        {bucket}
                      </span>
                      <p className="text-[11px] text-muted-foreground mt-0.5 leading-relaxed">
                        {CREATIVITY_LABELS[bucket]}
                      </p>
                    </div>
                  </div>

                  {/* Status */}
                  <div className="flex items-center justify-between pt-2 border-t border-border">
                    <span className="text-[10px] text-muted-foreground">
                      {saving ? 'Saving...' : error ? error : 'Changes saved automatically'}
                    </span>
                  </div>
                </>
              )}
            </>
          )}

          {tab === 'app' && (
            <>
              {/* API Key */}
              <div>
                <label className="text-xs font-medium text-foreground block mb-1.5">Anthropic API Key</label>
                <div className="flex gap-1.5">
                  <div className="flex-1 relative">
                    <input
                      type={showKey ? 'text' : 'password'}
                      value={apiKeyValue}
                      onChange={e => { setApiKeyValue(e.target.value); setKeySaved(false) }}
                      placeholder="sk-ant-api03-..."
                      className="w-full text-sm bg-surface border border-border rounded-lg px-3 py-2 pr-9 text-foreground font-mono focus:outline-none focus:ring-1 focus:ring-accent"
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
                    onClick={() => {
                      setApiKey(apiKeyValue)
                      setKeySaved(true)
                      setTimeout(() => setKeySaved(false), 2000)
                    }}
                    className="px-3 py-2 text-xs font-medium bg-accent text-accent-foreground rounded-lg hover:opacity-90 transition-opacity"
                  >
                    {keySaved ? 'Saved!' : 'Save'}
                  </button>
                </div>
                <p className="text-[10px] text-muted-foreground mt-1.5">
                  Your key is stored locally in this browser and sent with each request. It is never saved on the server.
                  {apiKeyValue && !apiKeyValue.startsWith('sk-ant-') && (
                    <span className="text-warning block mt-0.5">Key should start with "sk-ant-"</span>
                  )}
                </p>
                {!apiKeyValue && (
                  <p className="text-[10px] text-warning mt-1">
                    No API key set. The server's default key will be used if available.
                  </p>
                )}
              </div>

              {/* Theme */}
              <div>
                <label className="text-xs font-medium text-foreground block mb-1.5">Theme</label>
                <div className="flex gap-2">
                  <button
                    onClick={() => handleThemeChange(false)}
                    className={`flex-1 text-sm px-3 py-2 rounded-lg border transition-colors ${
                      !dark
                        ? 'border-accent bg-accent/10 text-foreground'
                        : 'border-border bg-surface text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    Light
                  </button>
                  <button
                    onClick={() => handleThemeChange(true)}
                    className={`flex-1 text-sm px-3 py-2 rounded-lg border transition-colors ${
                      dark
                        ? 'border-accent bg-accent/10 text-foreground'
                        : 'border-border bg-surface text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    Dark
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
