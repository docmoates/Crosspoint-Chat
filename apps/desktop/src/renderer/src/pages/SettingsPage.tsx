import { Menu, PanelLeft } from 'lucide-react'
import type { ReactElement } from 'react'
import { Soon } from '../components/ui/primitives'
import { cn } from '../lib/utils'
import { useApp, type SettingsTab } from '../store/app'
import { useConfig } from '../store/config'
import { DataSection } from './settings/Data'
import { AboutSection, DeviceSection, GeneralSection } from './settings/General'
import { HealthSection } from './settings/Health'
import { MemorySection } from './settings/Memory'
import { ModelsSection } from './settings/Models'
import { ProvidersSection } from './settings/Providers'
import { UsageSection } from './settings/Usage'

const LIVE: { tab: SettingsTab; label: string }[] = [
  { tab: 'general', label: 'General' },
  { tab: 'health', label: 'Health' },
  { tab: 'device', label: 'Device' },
  { tab: 'providers', label: 'Providers' },
  { tab: 'models', label: 'Models and tags' },
  { tab: 'memory', label: 'Memory' },
  { tab: 'usage', label: 'Usage' },
  { tab: 'data', label: 'Data and audit' },
  { tab: 'about', label: 'About and updates' },
]

const SOON: { tab: SettingsTab; label: string; text: string }[] = [
  {
    tab: 'soon-subchats',
    label: 'Sub-chats',
    text: 'Topic-aware sub-chats that keep working in the background and coordinate with each other.',
  },
  {
    tab: 'soon-local',
    label: 'Local models',
    text: 'Foundry Local models on this PC (NPU, GPU or CPU), with Auto routing between local and cloud and a Private mode.',
  },
  {
    tab: 'soon-images',
    label: 'Image generation',
    text: 'Local and cloud image generation. You write the prompt; the chat model proposes settings and you approve before anything runs.',
  },
  {
    tab: 'soon-search',
    label: 'Web search',
    text: 'Search and page fetching without a browser: result cache, local meta-search, direct sources, then Brave from admin.',
  },
  {
    tab: 'soon-mcp',
    label: 'MCP servers',
    text: 'Tools from MCP servers pushed by admin or added on this PC, with per-chat toggles.',
  },
  { tab: 'soon-skills', label: 'Skills', text: 'Skill folders (SKILL.md and scripts) triggered by slash commands or picked by the model.' },
  { tab: 'soon-tasks', label: 'Scheduled tasks', text: 'Prompts that run on a schedule and post results into a chat.' },
  { tab: 'soon-voice', label: 'Voice', text: 'Push-to-talk, continuous voice mode and read aloud.' },
]

function SoonSection(props: { label: string; text: string; tab: SettingsTab }): ReactElement {
  const config = useConfig((s) => s.config)
  const mcp = config?.mcp_servers ?? []
  return (
    <section>
      <h2 className="flex items-center gap-2">
        {props.label} <Soon />
      </h2>
      <p className="muted" style={{ margin: 0 }}>
        {props.text} This is not built yet; nothing here is active.
      </p>
      {props.tab === 'soon-mcp' && (
        <div className="card">
          <h3>Servers defined in admin</h3>
          {mcp.length === 0 ? (
            <div className="muted text-[13px]">None. Add MCP servers in admin; they will show here.</div>
          ) : (
            <div className="list">
              {mcp.map((s) => (
                <div className="row" key={s.id}>
                  <span className={s.enabled ? 'sdot ok' : 'sdot off'} />
                  <div className="grow">
                    {s.name}
                    <small>
                      {s.transport}
                      {!s.enabled && ' · disabled in admin'}
                    </small>
                  </div>
                  <Soon>not connected yet</Soon>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  )
}

export function SettingsPage(): ReactElement {
  const app = useApp()
  const tab = app.settingsTab
  const soon = SOON.find((s) => s.tab === tab)

  return (
    <section className="flex min-h-0 flex-1 flex-col">
      <div className="topbar">
        <button type="button" className="iconbtn mob-only" title="Menu" onClick={() => app.setSidebarMobile(true)}>
          <Menu />
        </button>
        {app.sidebarCollapsed && (
          <button type="button" className="iconbtn desk-only" title="Show sidebar" onClick={app.toggleSidebar}>
            <PanelLeft />
          </button>
        )}
        <div className="title">Settings</div>
      </div>
      <div className="settings">
        <nav className="snav" aria-label="Settings sections">
          {LIVE.map((s) => (
            <button key={s.tab} type="button" className={cn(tab === s.tab && 'on')} onClick={() => app.openSettings(s.tab)}>
              {s.label}
            </button>
          ))}
          <div className="eyebrow">Coming soon</div>
          {SOON.map((s) => (
            <button key={s.tab} type="button" className={cn(tab === s.tab && 'on')} onClick={() => app.openSettings(s.tab)}>
              <span className="faint">{s.label}</span>
            </button>
          ))}
        </nav>
        <div className="spane">
          {tab === 'general' && <GeneralSection />}
          {tab === 'health' && <HealthSection />}
          {tab === 'device' && <DeviceSection />}
          {tab === 'providers' && <ProvidersSection />}
          {tab === 'models' && <ModelsSection />}
          {tab === 'memory' && <MemorySection />}
          {tab === 'usage' && <UsageSection />}
          {tab === 'data' && <DataSection />}
          {tab === 'about' && <AboutSection />}
          {soon && <SoonSection {...soon} />}
        </div>
      </div>
    </section>
  )
}
