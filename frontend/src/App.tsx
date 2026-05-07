import { useState, useEffect } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import Home from './pages/Home'
import ProjectWorkspace from './pages/ProjectWorkspace'
import DocsOverview from './pages/docs/Overview'
import DocsConcepts from './pages/docs/Concepts'
import DocsGettingStarted from './pages/docs/GettingStarted'
import DocsWorkspace from './pages/docs/Workspace'
import DocsAgent from './pages/docs/Agent'
import DocsEvals from './pages/docs/Evals'
import DocsReference from './pages/docs/Reference'
import { checkHealth, hasApiKey } from './api'
import ApiKeyBanner from './components/ApiKeyBanner'
import LLMBillingBanner from './components/LLMBillingBanner'

export default function App() {
  const [needsKey, setNeedsKey] = useState(() => !hasApiKey())

  useEffect(() => {
    // If we already have a local key, no async check needed.
    if (hasApiKey()) return
    // No local key — check if server has a default.
    checkHealth().then(h => {
      setNeedsKey(!h.has_default_api_key)
    }).catch(() => {
      setNeedsKey(true)
    })
  }, [])

  return (
    <div className="flex flex-col h-screen">
      {needsKey && <ApiKeyBanner onDismiss={() => setNeedsKey(false)} />}
      <LLMBillingBanner />
      <div className="flex-1 min-h-0">
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/project/:sessionId" element={<ProjectWorkspace />} />
          <Route path="/docs" element={<DocsOverview />} />
          <Route path="/docs/concepts" element={<DocsConcepts />} />
          <Route path="/docs/getting-started" element={<DocsGettingStarted />} />
          <Route path="/docs/workspace" element={<DocsWorkspace />} />
          <Route path="/docs/agent" element={<DocsAgent />} />
          <Route path="/docs/evals" element={<DocsEvals />} />
          <Route path="/docs/reference" element={<DocsReference />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </div>
    </div>
  )
}
