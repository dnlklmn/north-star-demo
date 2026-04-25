import { useState, useEffect } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import Home from './pages/Home'
import ProjectWorkspace from './pages/ProjectWorkspace'
import { checkHealth, hasApiKey } from './api'
import ApiKeyBanner from './components/ApiKeyBanner'
import LLMBillingBanner from './components/LLMBillingBanner'

export default function App() {
  const [needsKey, setNeedsKey] = useState(false)

  useEffect(() => {
    // Check if we need to show the API key banner
    if (hasApiKey()) {
      setNeedsKey(false)
      return
    }
    // No local key — check if server has a default
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
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </div>
    </div>
  )
}
