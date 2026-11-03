import { contextBridge } from 'electron'

contextBridge.exposeInMainWorld('crosspoint', {})
