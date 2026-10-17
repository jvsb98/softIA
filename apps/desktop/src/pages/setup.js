;(async function () {
  const $ = (id) => document.getElementById(id)
  const input = $('url')
  const msg = $('msg')
  const say = (text, kind) => {
    msg.textContent = text
    msg.className = 'msg' + (kind ? ' ' + kind : '')
  }
  const busy = (on) => {
    $('test').disabled = on
    $('save').disabled = on
  }
  const cur = await window.setup.current()
  input.value = cur.url || ''
  $('ver').textContent = 'Versão ' + cur.version

  async function test() {
    busy(true)
    say('Testando…')
    const r = await window.setup.test(input.value)
    busy(false)
    if (r.ok) say(`Servidor encontrado (versão ${r.version}).`, 'ok')
    else say(r.message, 'err')
    return r
  }
  $('test').addEventListener('click', test)
  $('form').addEventListener('submit', async (e) => {
    e.preventDefault()
    const r = await test()
    if (r.ok) {
      say('Conectando…', 'ok')
      await window.setup.save(r.url)
    }
  })
})()
