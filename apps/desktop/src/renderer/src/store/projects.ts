import { create } from 'zustand'
import { api, errorText } from '../lib/api'
import type { Project, ProjectPatch } from '../lib/types'
import { useApp } from './app'

interface ProjectsState {
  projects: Project[]
  loaded: boolean
  error: string | null
  load(): Promise<void>
  create(name: string, instructions?: string): Promise<Project | null>
  update(id: string, patch: ProjectPatch): Promise<void>
  remove(id: string): Promise<void>
}

export const useProjects = create<ProjectsState>((set, get) => ({
  projects: [],
  loaded: false,
  error: null,

  async load() {
    try {
      set({ projects: await api.projects.list(), loaded: true, error: null })
    } catch (err) {
      set({ loaded: true, error: errorText(err) })
    }
  },

  async create(name, instructions) {
    try {
      const p = await api.projects.create({ name: name.trim(), instructions })
      set((s) => ({ projects: [p, ...s.projects] }))
      return p
    } catch (err) {
      useApp.getState().toast(`Could not create project: ${errorText(err)}`, 'error')
      return null
    }
  },

  async update(id, patch) {
    const prev = get().projects
    set({ projects: prev.map((p) => (p.id === id ? { ...p, ...patch } : p)) })
    try {
      await api.projects.update(id, patch)
    } catch (err) {
      set({ projects: prev })
      useApp.getState().toast(`Could not save project: ${errorText(err)}`, 'error')
    }
  },

  async remove(id) {
    try {
      await api.projects.remove(id)
      set((s) => ({ projects: s.projects.filter((p) => p.id !== id) }))
    } catch (err) {
      useApp.getState().toast(`Could not delete project: ${errorText(err)}`, 'error')
    }
  },
}))
