// Ponte segura entre o painel web e o app desktop (contextIsolation + sandbox).
// O front-end usa window.nimberDesktop quando existe; no navegador comum ele simplesmente não está lá.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('nimberDesktop', {
  isDesktop: true,
  platform: process.platform,
  /** Total de pendências (minhas não lidas + fila) → ícone da barra de tarefas e da bandeja. */
  setBadge: (n) => ipcRenderer.send('badge:set', Number(n) || 0),
  /** Chama a atenção (pisca na barra de tarefas) quando chega algo novo e a janela não está em foco. */
  badge: () => ipcRenderer.send('badge:flash'),
  /** Traz a janela para frente (ex.: clique numa notificação). */
  focus: () => ipcRenderer.send('win:focus'),
  /** Abre a tela para trocar o endereço do servidor. */
  changeServer: () => ipcRenderer.send('server:change'),
})

// Telas locais do app (configuração e servidor indisponível): só elas recebem a API de configuração.
if (location.protocol === 'file:') {
  contextBridge.exposeInMainWorld('setup', {
    current: () => ipcRenderer.invoke('setup:current'),
    test: (url) => ipcRenderer.invoke('setup:test', url),
    save: (url) => ipcRenderer.invoke('setup:save', url),
    retry: () => ipcRenderer.send('setup:retry'),
  })
}
