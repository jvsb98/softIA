// Campo de "frações": grade de quadrados em que alguns acendem em coral — o mesmo motivo das telas de login.
;(function () {
  const canvas = document.querySelector('.field canvas')
  if (!canvas) return
  const ctx = canvas.getContext('2d')
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches
  let cells = []
  const size = 18
  const gap = 6
  function layout() {
    const r = canvas.getBoundingClientRect()
    const dpr = devicePixelRatio || 1
    canvas.width = r.width * dpr
    canvas.height = r.height * dpr
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    const cols = Math.ceil(r.width / (size + gap))
    const rows = Math.ceil(r.height / (size + gap))
    cells = []
    for (let y = 0; y < rows; y++)
      for (let x = 0; x < cols; x++) {
        // faixa de frações acesas no meio; topo e base ficam quietos para o texto
        const t = y / rows
        const p = t < 0.18 || t > 0.76 ? 0 : Math.sin(((t - 0.18) / 0.58) * Math.PI) ** 1.6 * 0.42
        cells.push({ x, y, on: Math.random() < p, a: Math.random(), band: p > 0.05 })
      }
    draw()
  }
  function draw() {
    const r = canvas.getBoundingClientRect()
    ctx.clearRect(0, 0, r.width, r.height)
    for (const c of cells) {
      ctx.fillStyle = c.on ? `rgba(254,90,81,${0.35 + c.a * 0.65})` : 'rgba(153,193,228,0.06)'
      ctx.fillRect(c.x * (size + gap) + gap, c.y * (size + gap) + gap, size, size)
    }
  }
  addEventListener('resize', layout)
  layout()
  if (!reduce)
    setInterval(() => {
      const c = cells[(Math.random() * cells.length) | 0]
      if (c && c.band) {
        c.on = !c.on
        draw()
      }
    }, 900)
})()
