import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** The subset of Electron's `safeStorage` we use; injectable so tests run without Electron. */
export interface StringCipher {
  isEncryptionAvailable(): boolean
  encryptString(plain: string): Buffer
  decryptString(encrypted: Buffer): string
}

export class EncryptionUnavailableError extends Error {
  constructor() {
    super('Windows data protection (DPAPI) is not available, so secrets cannot be stored safely on this machine.')
    this.name = 'EncryptionUnavailableError'
  }
}

/**
 * A JSON value stored on disk encrypted with safeStorage (DPAPI on Windows).
 * Never falls back to plaintext: if encryption is unavailable, writes throw and reads return null.
 */
export class SecureFile<T> {
  constructor(
    readonly path: string,
    private readonly cipher: StringCipher
  ) {}

  read(): T | null {
    if (!existsSync(this.path)) return null
    if (!this.cipher.isEncryptionAvailable()) return null
    try {
      const plain = this.cipher.decryptString(readFileSync(this.path))
      return JSON.parse(plain) as T
    } catch {
      // Corrupt, or encrypted under another Windows user: treat as absent.
      return null
    }
  }

  write(value: T): void {
    if (!this.cipher.isEncryptionAvailable()) throw new EncryptionUnavailableError()
    mkdirSync(dirname(this.path), { recursive: true })
    const tmp = `${this.path}.tmp`
    writeFileSync(tmp, this.cipher.encryptString(JSON.stringify(value)))
    renameSync(tmp, this.path)
  }

  remove(): void {
    rmSync(this.path, { force: true })
    rmSync(`${this.path}.tmp`, { force: true })
  }

  exists(): boolean {
    return existsSync(this.path)
  }
}
