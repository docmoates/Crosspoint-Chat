// Type of `window.crosspoint` for the renderer. Import types from here or from packages/shared/ipc.ts.
// The surface is CrosspointApi in packages/shared/ipc.ts (docs/APP-CONTRACT.md), including
// artifacts.listAll, LocalSettings.fontSize, UsageDetail.pricing and HealthReport `fix` hints.
// Artifact previews load from `crosspoint-artifact://preview/<id>?v=<version>` (artifactPreviewUrl in
// packages/shared/channels.ts), not through this bridge.
import type { CrosspointApi } from '../../../../packages/shared/ipc'

export type * from '../../../../packages/shared/ipc'

declare global {
  interface Window {
    crosspoint: CrosspointApi
  }
}

export {}
