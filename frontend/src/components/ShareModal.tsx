import { useEffect, useState } from 'react'
import { Loader2, Copy, Check } from 'lucide-react'
import Button from './ui/Button'
import {
  createShareToken,
  listShareTokens,
  revokeShareToken,
} from '../api'
import type { CreatedShareToken, ShareTokenSummary } from '../types'

interface Props {
  sessionId: string
  open: boolean
  onClose: () => void
}

type Role = 'viewer' | 'editor'

/**
 * Owner-only modal for managing share links. The parent gates rendering on
 * role === 'owner' — this component itself just trusts that and won't make
 * sense in a viewer context (the API would 403 anyway).
 *
 * Plaintext tokens are only ever returned by the create endpoint; the list
 * endpoint returns previews. We hold the just-created token in local state
 * with a visible warning that it won't be shown again, mirroring how PAT/
 * OAuth-style tools surface secrets exactly once.
 */
export default function ShareModal({ sessionId, open, onClose }: Props) {
  const [tokens, setTokens] = useState<ShareTokenSummary[]>([])
  const [loadingList, setLoadingList] = useState(false)
  const [listError, setListError] = useState<string | null>(null)

  // Create form state
  const [role, setRole] = useState<Role>('viewer')
  const [label, setLabel] = useState('')
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)

  // The just-created token (plaintext, shown once)
  const [justCreated, setJustCreated] = useState<CreatedShareToken | null>(null)
  const [copied, setCopied] = useState(false)

  // Track which row is being revoked so the spinner is row-local.
  const [revokingId, setRevokingId] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    // Reset transient state every time the modal opens. We deliberately
    // keep `justCreated` cleared on open — if the user closed and reopened,
    // the plaintext is gone forever; surfacing it again on reopen would
    // suggest it's still recoverable.
    setJustCreated(null)
    setCopied(false)
    setCreateError(null)
    setListError(null)
    setLabel('')
    setRole('viewer')
    setLoadingList(true)
    listShareTokens(sessionId)
      .then((list) => setTokens(list))
      .catch((err) => setListError(err instanceof Error ? err.message : 'Failed to load'))
      .finally(() => setLoadingList(false))
  }, [open, sessionId])

  // Esc to close. Match other modal patterns in the codebase.
  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [open, onClose])

  if (!open) return null

  const buildShareUrl = (token: string): string => {
    return `${window.location.origin}/project/${sessionId}?shareToken=${encodeURIComponent(token)}`
  }

  const handleCreate = async () => {
    setCreating(true)
    setCreateError(null)
    try {
      const created = await createShareToken(sessionId, role, label || undefined)
      setJustCreated(created)
      // Prepend to the list so it shows up immediately. The created object
      // already has the same shape as a summary plus `token`.
      const summary: ShareTokenSummary = {
        id: created.id,
        role: created.role,
        label: created.label,
        token_preview: created.token_preview,
        created_at: created.created_at,
        revoked_at: created.revoked_at,
      }
      setTokens((prev) => [summary, ...prev])
      setLabel('')
      setCopied(false)
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : 'Failed to create')
    } finally {
      setCreating(false)
    }
  }

  const handleCopy = async () => {
    if (!justCreated) return
    try {
      await navigator.clipboard.writeText(buildShareUrl(justCreated.token))
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch (err) {
      console.error('Failed to copy:', err)
    }
  }

  const handleRevoke = async (tokenId: string) => {
    const ok = window.confirm('Revoke this share link?\n\nAnyone using it will lose access immediately.')
    if (!ok) return
    setRevokingId(tokenId)
    try {
      await revokeShareToken(sessionId, tokenId)
      setTokens((prev) =>
        prev.map((t) =>
          t.id === tokenId ? { ...t, revoked_at: new Date().toISOString() } : t,
        ),
      )
      // If we just revoked the token whose plaintext is showing, hide that
      // section — the link won't work any more so showing it is misleading.
      if (justCreated && justCreated.id === tokenId) {
        setJustCreated(null)
      }
    } catch (err) {
      // Surface inline on the row by re-throwing into the list error slot.
      setListError(err instanceof Error ? err.message : 'Failed to revoke')
    } finally {
      setRevokingId(null)
    }
  }

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
      onClick={onClose}
    >
      <div
        className="bg-surface-raised border border-border p-6 max-w-2xl w-full mx-4 shadow-lg flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-lg font-semibold text-foreground mb-1">Share project</h3>
        <p className="text-sm text-muted-foreground mb-5">
          Create read-only or edit links to share this project. Anyone with the
          link gets the role you select.
        </p>

        {/* Create new link */}
        <div className="border border-border p-4 mb-5">
          <div className="text-xs uppercase tracking-wide text-muted-foreground mb-3">
            Create new link
          </div>
          <div className="flex gap-2 mb-3">
            <select
              value={role}
              onChange={(e) => setRole(e.target.value as Role)}
              className="p-2 text-sm bg-background border border-border focus:outline-none focus:ring-1 focus:ring-accent text-foreground"
            >
              <option value="viewer">Viewer (read-only)</option>
              <option value="editor">Editor (can edit)</option>
            </select>
            <input
              type="text"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Label (optional, e.g. 'PM team')"
              className="flex-1 p-2 text-sm bg-background border border-border focus:outline-none focus:ring-1 focus:ring-accent text-foreground placeholder:text-muted-foreground"
            />
            <Button
              size="small"
              variant="primary"
              onClick={handleCreate}
              disabled={creating}
            >
              {creating ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
              Create
            </Button>
          </div>
          {createError && (
            <p className="text-xs text-danger">{createError}</p>
          )}

          {justCreated && (
            <div className="mt-3 p-3 bg-warning/10 border border-warning/40">
              <p className="text-xs font-semibold text-foreground mb-2">
                Copy this link now — it won't be shown again.
              </p>
              <div className="flex gap-2 items-center">
                <code className="flex-1 text-xs font-mono bg-background border border-border p-2 break-all">
                  {buildShareUrl(justCreated.token)}
                </code>
                <button
                  onClick={handleCopy}
                  className="flex items-center gap-1 px-3 py-2 text-xs font-medium bg-gray-150 text-gray-900 hover:bg-gray-200 transition-colors"
                  title="Copy link"
                >
                  {copied ? (
                    <>
                      <Check className="w-3 h-3" /> Copied
                    </>
                  ) : (
                    <>
                      <Copy className="w-3 h-3" /> Copy link
                    </>
                  )}
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Active links */}
        <div className="text-xs uppercase tracking-wide text-muted-foreground mb-2">
          Active links
        </div>
        {loadingList ? (
          <div className="flex items-center justify-center py-6">
            <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
          </div>
        ) : listError ? (
          <p className="text-sm text-danger">{listError}</p>
        ) : tokens.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4">
            No share links yet.
          </p>
        ) : (
          <div className="border border-border max-h-72 overflow-y-auto">
            {tokens.map((t) => {
              const revoked = !!t.revoked_at
              return (
                <div
                  key={t.id}
                  className={`flex items-center gap-3 px-3 py-2 border-b border-border last:border-b-0 ${
                    revoked ? 'opacity-50' : ''
                  }`}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 text-sm text-foreground">
                      <span className="font-medium truncate">
                        {t.label || <span className="text-muted-foreground italic">unlabeled</span>}
                      </span>
                      <span className="text-xs uppercase tracking-wide bg-fill-neutral px-1.5 py-0.5 text-muted-foreground">
                        {t.role}
                      </span>
                      {revoked && (
                        <span className="text-xs uppercase tracking-wide bg-danger/15 text-danger px-1.5 py-0.5">
                          revoked
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-muted-foreground font-mono mt-0.5">
                      {t.token_preview} · created {formatDate(t.created_at)}
                    </div>
                  </div>
                  {!revoked && (
                    <button
                      onClick={() => handleRevoke(t.id)}
                      disabled={revokingId === t.id}
                      className="text-xs px-2 py-1 text-danger hover:bg-danger/10 transition-colors"
                    >
                      {revokingId === t.id ? (
                        <Loader2 className="w-3 h-3 animate-spin" />
                      ) : (
                        'Revoke'
                      )}
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        )}

        <div className="flex justify-end mt-5">
          <Button size="small" variant="neutral" onClick={onClose}>
            Done
          </Button>
        </div>
      </div>
    </div>
  )
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString()
  } catch {
    return iso
  }
}
