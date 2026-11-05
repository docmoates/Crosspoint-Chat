import { LogIn } from 'lucide-react'
import { useState, type ReactElement } from 'react'
import { ErrorLine, Spinner } from '../components/ui/primitives'
import { usePairing } from '../store/pairing'

const MIN_PASSWORD = 12

/** Sign in, or create an account from an invite. Accounts are invite only. */
export function PairingPage(): ReactElement {
  const { status, busy, error, signIn, acceptInvite, clearError } = usePairing()
  const [invite, setInvite] = useState(false)
  const [code, setCode] = useState('')
  const [fullName, setFullName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')

  const valid = invite ? code.trim() !== '' && email.trim() !== '' && password.length >= MIN_PASSWORD : email.trim() !== '' && password !== ''
  const edit = (setter: (v: string) => void) => (e: { target: { value: string } }) => {
    setter(e.target.value)
    if (error) clearError()
  }

  return (
    <div className="pair-wrap">
      <form
        className="pair-card"
        onSubmit={(e) => {
          e.preventDefault()
          if (!valid || busy) return
          void (invite ? acceptInvite({ code, fullName, email, password }) : signIn(email, password)).then((ok) => ok && setPassword(''))
        }}
      >
        <div className="brand" style={{ flex: 'none', fontSize: 18 }}>
          <span className="logo" style={{ width: 30, height: 30, fontSize: 14, borderRadius: 8 }}>
            X
          </span>
          Crosspoint Chat
        </div>
        <div>
          <h1 style={{ fontSize: 22 }}>{invite ? 'Create your account' : 'Sign in'}</h1>
          <p className="muted" style={{ margin: '6px 0 0' }}>
            {invite ? 'Enter the invite code you were sent, then choose a password.' : 'Your chats, projects and files follow your account.'}
          </p>
        </div>
        <div className="card flex flex-col gap-3">
          {invite && (
            <>
              <label className="f">
                Invite code
                <input className="input mono" value={code} onChange={edit(setCode)} autoComplete="off" spellCheck={false} autoFocus />
              </label>
              <label className="f">
                Your name
                <input className="input" value={fullName} onChange={edit(setFullName)} autoComplete="name" />
              </label>
            </>
          )}
          <label className="f">
            Email
            <input className="input" type="email" value={email} onChange={edit(setEmail)} autoComplete="username" spellCheck={false} autoFocus={!invite} />
          </label>
          <label className="f">
            Password{invite ? ` (at least ${MIN_PASSWORD} characters)` : ''}
            <input className="input" type="password" value={password} onChange={edit(setPassword)} autoComplete={invite ? 'new-password' : 'current-password'} />
          </label>
          <ErrorLine error={error ?? status?.error} />
          <button type="submit" className="btn primary justify-center" disabled={!valid || busy}>
            {busy ? <Spinner /> : <LogIn className="ic-sm" />}
            {busy ? 'One moment…' : invite ? 'Create account' : 'Sign in'}
          </button>
        </div>
        <button
          type="button"
          className="btn self-start"
          onClick={() => {
            setInvite(!invite)
            clearError()
          }}
        >
          {invite ? 'I already have an account' : 'I have an invite'}
        </button>
      </form>
    </div>
  )
}
