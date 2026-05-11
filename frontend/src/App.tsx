import { useState, useEffect } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import Home from './pages/Home'
import ProjectWorkspace from './pages/ProjectWorkspace'
import { checkHealth, hasApiKey } from './api'
import ApiKeyBanner from './components/ApiKeyBanner'
import LLMBillingBanner from './components/LLMBillingBanner'
import { PolarisProvider } from './polaris/PolarisProvider'
import PolarisSidebar from './polaris/PolarisSidebar'

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
    <PolarisProvider>
      <div className="flex flex-col h-screen">
        {needsKey && <ApiKeyBanner onDismiss={() => setNeedsKey(false)} />}
        <LLMBillingBanner />
        {/* Page + sidebar in a flex row — opening the Polaris sidebar
            shrinks the routes column rather than overlaying it. */}
        <div className="flex-1 min-h-0 flex flex-row">
          <div className="flex-1 min-h-0">
            <Routes>
              <Route path="/" element={<Home />} />
              <Route path="/project/:sessionId" element={<ProjectWorkspace />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </div>
          <PolarisSidebar />
        </div>
      </div>
    </PolarisProvider>
  )
}
