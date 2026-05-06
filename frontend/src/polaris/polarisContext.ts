import { createContext } from 'react'
import type { PolarisContext } from '../api'

/**
 * Polaris context bus — the React context object lives here so the provider
 * file only exports a component (keeps Fast Refresh happy).
 */

export type PolarisNavHandler = (props: Record<string, unknown>) => void

export interface PolarisCtxShape {
  context: PolarisContext
  setContextSlice: (slice: Partial<PolarisContext>) => void
  registerNavHandler: (target: string, handler: PolarisNavHandler) => () => void
  dispatchNav: (nav: { target: string; props: Record<string, unknown> }) => void
  open: boolean
  setOpen: (v: boolean | ((prev: boolean) => boolean)) => void
}

export const PolarisCtx = createContext<PolarisCtxShape | null>(null)
