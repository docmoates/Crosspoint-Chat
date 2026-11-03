import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}

export function usd(n: number | undefined | null, digits?: number): string {
  if (n == null || Number.isNaN(n)) return '$0.00'
  const d = digits ?? (n !== 0 && Math.abs(n) < 0.1 ? 3 : 2)
  return `$${n.toFixed(d)}`
}

export function num(n: number | undefined | null): string {
  return n == null ? '0' : n.toLocaleString('en-US')
}

/** Price per million tokens (the catalog stores USD per 1M), as the picker shows it. */
export function perM(n: number | null | undefined): string {
  if (n == null) return '?'
  if (n === 0) return '0'
  return n >= 10 ? n.toFixed(0) : n.toFixed(n < 1 ? 2 : 1).replace(/\.0$/, '')
}

export function ctx(n: number | null | undefined): string {
  if (!n) return ''
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0)}M ctx`
  return `${Math.round(n / 1000)}K ctx`
}

export function bytes(n: number | null | undefined): string {
  if (n == null) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

export function dayGroup(iso: string | null | undefined, now = new Date()): string {
  if (!iso) return 'Older'
  const t = new Date(iso)
  if (Number.isNaN(t.getTime())) return 'Older'
  const diff = Math.round((startOfDay(now) - startOfDay(t)) / 86_400_000)
  if (diff <= 0) return 'Today'
  if (diff === 1) return 'Yesterday'
  if (diff < 7) return 'Previous 7 days'
  if (diff < 30) return 'Previous 30 days'
  return t.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
}

export function relTime(iso: string | null | undefined): string {
  if (!iso) return ''
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return ''
  const s = Math.round((Date.now() - t) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`
  const d = Math.floor(s / 86_400)
  if (d < 7) return `${d} day${d === 1 ? '' : 's'} ago`
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

export function initials(name: string | undefined): string {
  if (!name) return 'PC'
  const parts = name.trim().split(/[\s\-_]+/).filter(Boolean)
  const first = parts[0] ?? 'P'
  return (first[0] ?? 'P').concat(parts[1]?.[0] ?? first[1] ?? '').toUpperCase()
}

export function uid(prefix = 'tmp'): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`
}

export const TAG_PALETTE = ['#6d28d9', '#be185d', '#15803d', '#0369a1', '#b45309', '#0f766e', '#64748b', '#dc2626']

export function fileToBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => {
      const s = String(r.result)
      resolve(s.slice(s.indexOf(',') + 1))
    }
    r.onerror = () => reject(r.error ?? new Error('Could not read file'))
    r.readAsDataURL(file)
  })
}

export const ADMIN_HOST_DEFAULT = 'admin.docmoates.com'

export function adminUrl(host: string | undefined, path = ''): string {
  const h = (host || ADMIN_HOST_DEFAULT).replace(/\/+$/, '')
  return `${/^https?:\/\//.test(h) ? h : `https://${h}`}${path}`
}
