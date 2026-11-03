import { protocol } from 'electron'
import { ARTIFACT_PROTOCOL } from '@shared/channels'
import { ARTIFACT_PREVIEW_CSP, previewDocument, type ArtifactStore } from './services/artifacts'

/** Must run before `app.whenReady()`. */
export function registerArtifactScheme(): void {
  protocol.registerSchemesAsPrivileged([
    // standard: real URLs with a host; secure: counts as a secure context. No fetch/CORS/service-worker privileges.
    { scheme: ARTIFACT_PROTOCOL, privileges: { standard: true, secure: true } }
  ])
}

const text = (status: number, body: string): Response =>
  new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff' } })

/**
 * Serves `crosspoint-artifact://preview/<id>?v=<version>` with the artifact's current HTML/SVG and a
 * preview-only CSP. The renderer embeds it in `<iframe sandbox="allow-scripts allow-modals">`, so the
 * document runs in an opaque origin without the preload or IPC.
 */
export function handleArtifactProtocol(artifacts: () => ArtifactStore | null): void {
  protocol.handle(ARTIFACT_PROTOCOL, (req) => {
    if (req.method !== 'GET') return text(405, 'Method not allowed')
    let url: URL
    try {
      url = new URL(req.url)
    } catch {
      return text(400, 'Bad URL')
    }
    const m = /^\/([A-Za-z0-9-]{1,200})\/?$/.exec(url.pathname)
    const store = artifacts()
    if (url.hostname !== 'preview' || !m || !store) return text(404, 'Not found')
    let doc: string | null
    try {
      doc = previewDocument(store.get(m[1]!))
    } catch {
      return text(404, 'Not found')
    }
    if (doc === null) return text(415, 'No preview for this artifact kind')
    return new Response(doc, {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': ARTIFACT_PREVIEW_CSP,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer'
      }
    })
  })
}
