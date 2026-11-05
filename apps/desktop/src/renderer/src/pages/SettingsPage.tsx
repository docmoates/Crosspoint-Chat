import { Menu, PanelLeft } from 'lucide-react'
import type { ReactElement } from 'react'
import { cn } from '../lib/utils'
import { useApp, type SettingsTab } from '../store/app'
import { DataSection } from './settings/Data'
import { AboutSection, DeviceSection, GeneralSection } from './settings/General'
import { HealthSection } from './settings/Health'
import { MemorySection } from './settings/Memory'
import { UsageSection } from './settings/Usage'

const TABS: { tab: SettingsTab; label: string }[] = [
  { tab: 'general', label: 'General' },
  { tab: 'health', label: 'Health' },
  { tab: 'device', label: 'Device' },
  { tab: 'memory', label: 'Memory' },
  { tab: 'usage', label: 'Usage' },
  { tab: 'data', label: 'Data and audit' },
  { tab: 'about', label: 'About and updates' },
]

export function SettingsPage(): ReactElement {
  const app = useApp()
  const tab = app.settingsTab

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
          {TABS.map((s) => (
            <button key={s.tab} type="button" className={cn(tab === s.tab && 'on')} onClick={() => app.openSettings(s.tab)}>
              {s.label}
            </button>
          ))}
        </nav>
        <div className="spane">
          {tab === 'general' && <GeneralSection />}
          {tab === 'health' && <HealthSection />}
          {tab === 'device' && <DeviceSection />}
          {tab === 'memory' && <MemorySection />}
          {tab === 'usage' && <UsageSection />}
          {tab === 'data' && <DataSection />}
          {tab === 'about' && <AboutSection />}
        </div>
      </div>
    </section>
  )
}
