/*
 * softIA — vigia de carregamento.
 *
 * Roda antes do painel (script comum, sem módulo) para que qualquer falha de carregamento apareça
 * na tela com o motivo, em vez de uma página em branco:
 *  - arquivo do painel que não carregou (404, tipo errado, bloqueado);
 *  - erro de JavaScript ao iniciar;
 *  - painel que montou e depois sumiu (erro fora da proteção de telas).
 * Na primeira falha recarrega a página uma vez sozinho (resolve cache antigo depois de atualizar).
 */
;(function () {
  'use strict'
  var errors = []
  var started = Date.now()
  var everMounted = false
  var shown = false
  var RELOAD_FLAG = 'na:boot-reload'

  function add(msg) {
    msg = String(msg)
    if (errors.length < 15 && errors.indexOf(msg) < 0) errors.push(msg)
  }

  window.addEventListener(
    'error',
    function (e) {
      var t = e.target
      if (t && t !== window && (t.tagName === 'SCRIPT' || t.tagName === 'LINK')) {
        add('Não carregou: ' + (t.src || t.href))
      } else {
        var where = e.filename ? ' (' + String(e.filename).split('/').pop() + ':' + e.lineno + ')' : ''
        add((e.error && e.error.name ? e.error.name + ': ' : '') + (e.message || 'Erro') + where)
      }
    },
    true,
  )
  window.addEventListener('unhandledrejection', function (e) {
    var r = e.reason
    add('Promessa rejeitada: ' + (r && (r.message || r)))
  })
  window.__naBoot = { errors: errors }

  function root() {
    return document.getElementById('root')
  }
  // Montado = existe algo além da área de notificações (que sempre aparece, mesmo com o painel vazio)
  function mounted() {
    var r = root()
    if (!r) return false
    for (var i = 0; i < r.children.length; i++) {
      var c = r.children[i]
      if (!(c.tagName === 'SECTION' && /^Notifications/.test(c.getAttribute('aria-label') || ''))) return true
    }
    return false
  }
  function setFlag(v) {
    try {
      if (v) sessionStorage.setItem(RELOAD_FLAG, String(Date.now()))
      else sessionStorage.removeItem(RELOAD_FLAG)
    } catch (e) {}
  }
  function flagRecent() {
    try {
      return Date.now() - Number(sessionStorage.getItem(RELOAD_FLAG) || 0) < 60000
    } catch (e) {
      return true
    }
  }

  function probeScripts(done) {
    var scripts = document.querySelectorAll('script[type="module"][src], link[rel="stylesheet"][href]')
    var pending = scripts.length
    if (!pending || !window.fetch) return done()
    for (var i = 0; i < scripts.length; i++) {
      ;(function (el) {
        var url = el.src || el.href
        fetch(url, { cache: 'no-store' })
          .then(function (r) {
            add('Teste ' + url.replace(location.origin, '') + ': HTTP ' + r.status + ', ' + (r.headers.get('content-type') || 'sem tipo'))
          })
          .catch(function (err) {
            add('Teste ' + url.replace(location.origin, '') + ': falhou (' + err.message + ')')
          })
          .then(function () {
            if (--pending === 0) done()
          })
      })(scripts[i])
    }
  }

  function el(tag, style, text) {
    var n = document.createElement(tag)
    if (style) n.setAttribute('style', style)
    if (text) n.textContent = text
    return n
  }

  function show(title) {
    if (shown) return
    shown = true
    probeScripts(function () {
      var report =
        title +
        '\n\n' +
        (errors.length ? errors.join('\n') : 'Nenhum erro foi registrado pelo navegador.') +
        '\n\nEndereço: ' +
        location.href +
        '\nNavegador: ' +
        navigator.userAgent +
        '\nHorário: ' +
        new Date().toString()
      var dark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches
      var bg = dark ? '#020515' : '#F6F1E7'
      var panel = dark ? '#0a1a33' : '#FFFDF8'
      var ink = dark ? '#F6F1E7' : '#071832'
      var line = dark ? '#1d2d4a' : '#E4DDCF'
      var box = el(
        'div',
        'position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;padding:24px;background:' +
          bg +
          ';color:' +
          ink +
          ';font:14px/1.5 "DM Sans","Segoe UI",system-ui,sans-serif',
      )
      var card = el('div', 'width:100%;max-width:640px;border:1px solid ' + line + ';border-radius:14px;padding:24px;background:' + panel)
      card.appendChild(el('div', 'font:400 26px/1.2 Tinos,Georgia,serif;margin-bottom:8px', title))
      card.appendChild(
        el(
          'div',
          'opacity:.85',
          'Tente "Recarregar sem cache". Se continuar, clique em "Copiar diagnóstico" e envie para a equipe de tecnologia.',
        ),
      )
      card.appendChild(
        el(
          'pre',
          'margin:16px 0;max-height:260px;overflow:auto;white-space:pre-wrap;border-radius:8px;padding:12px;font:12px/1.5 Consolas,monospace;background:' +
            (dark ? '#020515' : '#F2ECE0'),
          report,
        ),
      )
      var row = el('div', 'display:flex;gap:8px;flex-wrap:wrap')
      var b1 = el('button', 'height:40px;padding:0 16px;border:0;border-radius:10px;background:#FE5A51;color:#fff;font:500 14px inherit;cursor:pointer', 'Recarregar sem cache')
      b1.onclick = function () {
        setFlag(false)
        location.replace('/?r=' + Date.now())
      }
      var b2 = el(
        'button',
        'height:40px;padding:0 16px;border:1px solid ' + line + ';border-radius:10px;background:transparent;color:' + ink + ';font:500 14px inherit;cursor:pointer',
        'Copiar diagnóstico',
      )
      b2.onclick = function () {
        try {
          navigator.clipboard.writeText(report)
          b2.textContent = 'Copiado'
        } catch (e) {
          window.prompt('Copie o diagnóstico:', report)
        }
      }
      row.appendChild(b1)
      row.appendChild(b2)
      card.appendChild(row)
      box.appendChild(card)
      document.body.appendChild(box)
    })
  }

  function check() {
    if (shown) return
    if (mounted()) {
      if (!everMounted) {
        everMounted = true
        setFlag(false)
        watchUnmount()
      }
      return
    }
    if (Date.now() - started < 6000) return setTimeout(check, 400)
    // Primeira falha: recarrega uma vez (revalida a página e os arquivos do painel)
    if (!flagRecent()) {
      setFlag(true)
      location.reload()
      return
    }
    show('O painel não carregou')
  }

  function watchUnmount() {
    var r = root()
    if (!r || !window.MutationObserver) return
    var timer = null
    new MutationObserver(function () {
      if (!mounted()) {
        clearTimeout(timer)
        timer = setTimeout(function () {
          if (!mounted()) show('O painel parou com um erro')
        }, 1500)
      }
    }).observe(r, { childList: true })
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', check)
  else check()
})()
