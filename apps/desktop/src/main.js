/**
 * Nimber Atende — app desktop (Electron).
 *
 * Abre o painel do servidor numa janela própria, com:
 *  - primeira execução: tela para informar o endereço do servidor (ou endereço pré-configurado pela TI);
 *  - ícone na bandeja: fechar a janela não encerra, as notificações continuam chegando;
 *  - notificações nativas do Windows e contador de pendências na barra de tarefas;
 *  - início automático com o Windows (opcional, minimizado na bandeja);
 *  - tela de "servidor indisponível" com nova tentativa automática.
 * Nada do atendimento roda aqui: o servidor continua sendo a fonte de tudo.
 */
const { app, BrowserWindow, Menu, Tray, ipcMain, nativeImage, nativeTheme, net, session, shell, dialog } = require('electron')
const path = require('node:path')
const settings = require('./settings')

const APP_ID = 'br.com.nimber.atende'
const asset = (name) => path.join(__dirname, '..', 'build', name)
const startHidden = process.argv.includes('--hidden')

let win = null
let tray = null
let quitting = false
let pending = 0
let retryTimer = null

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => showWindow())
}
app.setAppUserModelId(APP_ID) // necessário para as notificações do Windows

const serverUrl = () => settings.read().serverUrl || null
const bg = () => (nativeTheme.shouldUseDarkColors ? '#020515' : '#F6F1E7')

function sameOrigin(url) {
  try {
    return new URL(url).origin === serverUrl()
  } catch {
    return false
  }
}

function createWindow() {
  const saved = settings.read().bounds
  win = new BrowserWindow({
    width: saved?.width ?? 1360,
    height: saved?.height ?? 860,
    x: saved?.x,
    y: saved?.y,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    title: 'Nimber Atende',
    icon: asset('icon.png'),
    backgroundColor: bg(),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: true,
    },
  })
  if (settings.read().maximized) win.maximize()

  win.once('ready-to-show', () => {
    if (!startHidden) win.show()
  })

  win.on('close', (e) => {
    const b = win.getNormalBounds()
    settings.write({ bounds: b, maximized: win.isMaximized() })
    if (!quitting) {
      e.preventDefault()
      win.hide()
      if (!settings.read().trayHintShown && tray) {
        tray.displayBalloon?.({
          title: 'Nimber Atende continua aberto',
          content: 'As notificações seguem chegando. Para sair, use o ícone da bandeja → Sair.',
          iconType: 'info',
        })
        settings.write({ trayHintShown: true })
      }
    }
  })

  win.on('focus', () => win.flashFrame(false))

  // Links externos abrem no navegador; downloads de mídia do próprio servidor ficam no app
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (sameOrigin(url) && new URL(url).pathname.startsWith('/api/')) {
      win.webContents.downloadURL(url)
      return { action: 'deny' }
    }
    if (/^https?:|^mailto:|^tel:/i.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    if (url.startsWith('file:')) return
    if (!sameOrigin(url)) {
      e.preventDefault()
      if (/^https?:/i.test(url)) shell.openExternal(url)
    }
  })

  win.webContents.on('did-fail-load', (_e, code, _desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3 /* ABORTED */ || url.startsWith('file:')) return
    showOffline()
  })

  // Atalhos sem menu: F5/Ctrl+R recarrega, Ctrl+Shift+I ferramentas, Ctrl +/-/0 zoom
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return
    const ctrl = input.control || input.meta
    const k = input.key.toLowerCase()
    if (k === 'f5' || (ctrl && k === 'r')) {
      win.webContents.reload()
      e.preventDefault()
    } else if (ctrl && input.shift && k === 'i') {
      win.webContents.toggleDevTools()
      e.preventDefault()
    } else if (ctrl && (k === '=' || k === '+')) {
      win.webContents.setZoomLevel(Math.min(3, win.webContents.getZoomLevel() + 0.5))
      e.preventDefault()
    } else if (ctrl && k === '-') {
      win.webContents.setZoomLevel(Math.max(-3, win.webContents.getZoomLevel() - 0.5))
      e.preventDefault()
    } else if (ctrl && k === '0') {
      win.webContents.setZoomLevel(0)
      e.preventDefault()
    }
  })
}

function loadSetup() {
  clearTimeout(retryTimer)
  win.loadFile(path.join(__dirname, 'pages', 'setup.html'))
  showWindow()
}

function showOffline() {
  clearTimeout(retryTimer)
  win.loadFile(path.join(__dirname, 'pages', 'offline.html'))
  retryTimer = setTimeout(() => loadServer(), 15_000)
}

function loadServer() {
  clearTimeout(retryTimer)
  const url = serverUrl()
  if (!url) return loadSetup()
  win.loadURL(url + '/atendimento')
}

function showWindow() {
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

// ------------------------------------------------------------------ bandeja e contador
function setPending(n) {
  pending = Math.max(0, n | 0)
  if (process.platform === 'win32' && win) {
    win.setOverlayIcon(pending > 0 ? nativeImage.createFromPath(asset('badge.png')) : null, pending > 0 ? `${pending} pendente(s)` : '')
  } else {
    app.setBadgeCount(pending)
  }
  if (tray) tray.setToolTip(pending > 0 ? `Nimber Atende — ${pending} pendente(s)` : 'Nimber Atende')
}

function buildTrayMenu() {
  const login = app.getLoginItemSettings({ args: ['--hidden'] }).openAtLogin
  return Menu.buildFromTemplate([
    { label: 'Abrir o Nimber Atende', click: showWindow },
    { label: 'Recarregar', click: () => (serverUrl() ? loadServer() : loadSetup()) },
    { type: 'separator' },
    {
      label: 'Iniciar com o Windows',
      type: 'checkbox',
      checked: login,
      click: (item) => {
        app.setLoginItemSettings({ openAtLogin: item.checked, args: ['--hidden'] })
        tray.setContextMenu(buildTrayMenu())
      },
    },
    { label: 'Trocar servidor…', click: loadSetup },
    { label: `Servidor: ${serverUrl() ?? 'não configurado'}`, enabled: false },
    { type: 'separator' },
    {
      label: 'Sair',
      click: () => {
        quitting = true
        app.quit()
      },
    },
  ])
}

function createTray() {
  const img = nativeImage.createFromPath(asset('tray.png'))
  img.addRepresentation({ scaleFactor: 2, buffer: nativeImage.createFromPath(asset('tray@2x.png')).toPNG() })
  tray = new Tray(img)
  tray.setToolTip('Nimber Atende')
  tray.setContextMenu(buildTrayMenu())
  tray.on('click', showWindow)
  tray.on('double-click', showWindow)
}

// ------------------------------------------------------------------ permissões do painel
function configureSession() {
  const ses = session.defaultSession
  ses.setSpellCheckerLanguages(['pt-BR'])
  const allowed = new Set(['notifications', 'clipboard-sanitized-write', 'fullscreen'])
  ses.setPermissionRequestHandler((wc, permission, cb, details) => {
    cb(allowed.has(permission) && sameOrigin(details.requestingUrl || wc.getURL()))
  })
  ses.setPermissionCheckHandler((_wc, permission, origin) => allowed.has(permission) && sameOrigin(origin))
  ses.on('will-download', (_e, item) => {
    item.setSaveDialogOptions({ title: 'Salvar arquivo', defaultPath: path.join(app.getPath('downloads'), item.getFilename()) })
  })
}

// ------------------------------------------------------------------ IPC
ipcMain.on('badge:set', (_e, n) => setPending(n))
ipcMain.on('badge:flash', () => {
  if (win && !win.isFocused()) win.flashFrame(true)
})
ipcMain.on('win:focus', showWindow)
ipcMain.on('server:change', loadSetup)
ipcMain.on('setup:retry', (e) => isLocalPage(e) && loadServer())

/** As chamadas de configuração só valem vindas das páginas locais do app, nunca do servidor. */
function isLocalPage(e) {
  return String(e.senderFrame?.url ?? '').startsWith('file:')
}

ipcMain.handle('setup:current', () => ({ url: serverUrl() ?? settings.presetUrl() ?? '', version: app.getVersion() }))

ipcMain.handle('setup:test', async (e, input) => {
  if (!isLocalPage(e)) return { ok: false, message: 'Não permitido.' }
  const url = settings.normalizeUrl(input)
  if (!url) return { ok: false, message: 'Endereço inválido. Exemplo: http://servidor-nimber:8080' }
  try {
    const res = await net.fetch(url + '/api/health', { signal: AbortSignal.timeout(6000) })
    const body = await res.json().catch(() => ({}))
    if (body.app !== 'nimber-atende') return { ok: false, message: 'Esse endereço respondeu, mas não é um servidor do Nimber Atende.' }
    return { ok: true, url, version: body.version }
  } catch (err) {
    return { ok: false, message: `Não consegui falar com ${url}. Confira o endereço, a rede e se o serviço está rodando. (${err.message})` }
  }
})

ipcMain.handle('setup:save', (e, input) => {
  if (!isLocalPage(e)) return { ok: false }
  const url = settings.normalizeUrl(input)
  if (!url) return { ok: false }
  settings.write({ serverUrl: url })
  if (tray) tray.setContextMenu(buildTrayMenu())
  loadServer()
  return { ok: true }
})

// ------------------------------------------------------------------ ciclo de vida
app.whenReady().then(() => {
  Menu.setApplicationMenu(null)
  configureSession()
  if (!serverUrl()) {
    const preset = settings.presetUrl()
    if (preset) settings.write({ serverUrl: preset })
  }
  createWindow()
  createTray()
  if (serverUrl()) loadServer()
  else loadSetup()
  nativeTheme.on('updated', () => win?.setBackgroundColor(bg()))
})

app.on('before-quit', () => {
  quitting = true
})

app.on('window-all-closed', () => {
  // permanece na bandeja
})

process.on('uncaughtException', (err) => {
  dialog.showErrorBox('Nimber Atende', `Erro inesperado: ${err.message}`)
})
