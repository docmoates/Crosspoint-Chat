// Placeholder entry so the app builds before the real renderer lands. Replace freely.
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

function App(): React.JSX.Element {
  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: 24 }}>
      <h1 style={{ fontSize: 18, fontWeight: 600 }}>Crosspoint Chat</h1>
    </main>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
