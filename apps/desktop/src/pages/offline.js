;(async function () {
  const cur = await window.setup.current()
  if (cur.url) document.getElementById('lead').textContent = `O servidor ${cur.url} não respondeu. Vou tentar de novo sozinho a cada 15 segundos.`
  document.getElementById('retry').addEventListener('click', () => {
    document.getElementById('msg').textContent = 'Tentando…'
    window.setup.retry()
  })
  document.getElementById('change').addEventListener('click', () => {
    location.href = 'setup.html'
  })
})()
