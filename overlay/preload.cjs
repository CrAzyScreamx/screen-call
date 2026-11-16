const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('sc', {
  onEvent: (fn) => ipcRenderer.on('sc:event', (_e, ev) => fn(ev)),
  sendChat: (text, snaps) => ipcRenderer.send('sc:chat', text, snaps),
  snap: () => ipcRenderer.invoke('sc:snap'),
  voice: (audio, snaps) => ipcRenderer.invoke('sc:voice', audio, snaps),
  quit: () => ipcRenderer.send('sc:quit'),
  repick: () => ipcRenderer.send('sc:repick'),
  // picker
  sources: () => ipcRenderer.invoke('sc:sources'),
  pick: (id) => ipcRenderer.send('sc:pick', id),
})
