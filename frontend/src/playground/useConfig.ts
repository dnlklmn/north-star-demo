import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react'
import { getConfig, type DeploymentConfig } from '../api'

/**
 * Deployment-config provider.
 *
 * The backend's `GET /config` returns per-deployment flags (Polaris on/off,
 * quota headroom, model). We fetch once on mount and cache the result for
 * the lifetime of the app — config is process-level on the server, so a
 * page reload is the right invalidation trigger.
 *
 * `null` while the fetch is in flight or if it failed; consumers should
 * treat null as "don't change behaviour yet" rather than "feature off".
 * That way a slow or unreachable /config never accidentally disables
 * features in a private deployment where the user clearly has access.
 */

const ConfigCtx = createContext<DeploymentConfig | null>(null)

export function ConfigProvider({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<DeploymentConfig | null>(null)

  useEffect(() => {
    let cancelled = false
    getConfig()
      .then(c => {
        if (!cancelled) setConfig(c)
      })
      .catch(() => {
        // Swallow — null means "treat features as available", matching
        // the safe-default rule above. The error path already shows
        // banners via apiFetch for billing/auth issues.
      })
    return () => {
      cancelled = true
    }
  }, [])

  return createElement(ConfigCtx.Provider, { value: config }, children)
}

export function useConfig(): DeploymentConfig | null {
  return useContext(ConfigCtx)
}
