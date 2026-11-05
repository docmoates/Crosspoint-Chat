import { Check, ChevronRight, Code2, Copy } from 'lucide-react'
import { memo, useState, type ReactElement, type ReactNode } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import rehypeHighlight from 'rehype-highlight'
import remarkGfm from 'remark-gfm'
import { api } from '../lib/api'

function textOf(node: ReactNode): string {
  if (node == null || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node === 'object' && 'props' in node) {
    return textOf((node as { props: { children?: ReactNode } }).props.children)
  }
  return ''
}

export function CopyButton(props: { text: string; label?: boolean; className?: string }): ReactElement {
  const [done, setDone] = useState(false)
  return (
    <button
      type="button"
      className={props.className}
      title="Copy"
      onClick={() => {
        void navigator.clipboard.writeText(props.text).then(() => {
          setDone(true)
          window.setTimeout(() => setDone(false), 1200)
        })
      }}
    >
      {done ? <Check className="ic-sm" /> : <Copy className="ic-sm" />}
      {props.label && (done ? 'Copied' : 'Copy')}
    </button>
  )
}

function CodeBlock(props: { children?: ReactNode }): ReactElement {
  const child = Array.isArray(props.children) ? props.children[0] : props.children
  const className =
    child && typeof child === 'object' && 'props' in child
      ? String((child as { props: { className?: string } }).props.className ?? '')
      : ''
  const lang = /language-([\w+-]+)/.exec(className)?.[1] ?? ''
  const raw = textOf(props.children).replace(/\n$/, '')
  const lines = raw.split('\n').length
  // Anything longer than a few lines is a dropdown that starts closed; short snippets stay inline.
  const foldable = lines > 8
  const [open, setOpen] = useState(false)
  const closed = foldable && !open
  return (
    <div className={closed ? 'code collapsed' : 'code'}>
      <div
        className={foldable ? 'bar foldable' : 'bar'}
        role={foldable ? 'button' : undefined}
        tabIndex={foldable ? 0 : undefined}
        aria-expanded={foldable ? open : undefined}
        onClick={foldable ? () => setOpen((v) => !v) : undefined}
        onKeyDown={
          foldable
            ? (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  setOpen((v) => !v)
                }
              }
            : undefined
        }
      >
        <Code2 className="ic-sm" />
        {lang || 'code'}
        {foldable && <span className="faint">{lines} lines</span>}
        <span onClick={(e) => e.stopPropagation()} style={{ marginLeft: 'auto', display: 'inline-flex' }}>
          <CopyButton text={raw} label />
        </span>
        {foldable && <ChevronRight className="chev ic-sm" />}
      </div>
      <pre>{props.children}</pre>
    </div>
  )
}

const components: Components = {
  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
  a: ({ href, children }) => (
    <a
      href={href}
      onClick={(e) => {
        e.preventDefault()
        if (href && /^https?:\/\//.test(href)) void api.app.openExternal(href)
      }}
    >
      {children}
    </a>
  ),
}

function MarkdownImpl(props: { text: string }): ReactElement {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={components}
      >
        {props.text}
      </ReactMarkdown>
    </div>
  )
}

export const Markdown = memo(MarkdownImpl)
