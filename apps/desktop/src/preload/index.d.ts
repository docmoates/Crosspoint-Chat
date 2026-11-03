// Type of `window.crosspoint` for the renderer. Import types from here or from packages/shared/ipc.ts.
import type { CrosspointApi } from '../../../../packages/shared/ipc'

export type * from '../../../../packages/shared/ipc'

declare global {
  interface Window {
    crosspoint: CrosspointApi
  }
}

export {}
