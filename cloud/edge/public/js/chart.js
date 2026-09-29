// Gráficas en canvas sin dependencias (funciona sin internet en la Raspberry)

function setup(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const { width, height } = canvas.getBoundingClientRect();
  if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
    canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  return { ctx, w: width, h: height };
}

const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

export function sparkline(canvas, values, color) {
  const { ctx, w, h } = setup(canvas);
  const pts = values.filter((v) => v != null);
  if (pts.length < 2) return;
  let min = Math.min(...pts), max = Math.max(...pts);
  if (max - min < 1e-6) { min -= 1; max += 1; }
  const x = (i) => (i / (values.length - 1)) * w;
  const y = (v) => h - 2 - ((v - min) / (max - min)) * (h - 4);
  ctx.beginPath();
  let started = false;
  values.forEach((v, i) => {
    if (v == null) { started = false; return; }
    started ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v));
    started = true;
  });
  ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.stroke();
  ctx.lineTo(w, h); ctx.lineTo(0, h); ctx.closePath();
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, color + '33'); g.addColorStop(1, color + '00');
  ctx.fillStyle = g; ctx.fill();
}

function niceTicks(min, max, n = 5) {
  const span = max - min || 1;
  const step0 = span / n;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= step0);
  const t = [];
  for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) t.push(+v.toFixed(6));
  return t;
}

export class LineChart {
  constructor(canvas) {
    this.canvas = canvas;
    this.series = [];
    this.hover = null;
    canvas.addEventListener('mousemove', (e) => { this.hover = e.offsetX; this.draw(); });
    canvas.addEventListener('mouseleave', () => { this.hover = null; this.draw(); });
    new ResizeObserver(() => this.draw()).observe(canvas);
  }

  set({ series, unit = '', range }) { this.series = series; this.unit = unit; this.range = range; this.draw(); }

  draw() {
    const { ctx, w, h } = setup(this.canvas);
    const pad = { l: 52, r: 12, t: 12, b: 26 };
    const muted = css('--muted'), line = css('--line'), text = css('--text');
    ctx.font = `12px ${css('--mono')}`;
    const all = this.series.flatMap((s) => [
      ...s.data.map((d) => d[1]),
      ...(s.band || []).flatMap((b) => [b[1], b[2]]),
    ].filter((v) => v != null));
    if (!this.range) return;
    const [t0, t1] = this.range;
    if (!all.length) {
      ctx.fillStyle = muted; ctx.textAlign = 'center';
      ctx.fillText('Sin datos en este periodo', w / 2, h / 2);
      return;
    }
    let min = Math.min(...all), max = Math.max(...all);
    const m = (max - min) * 0.1 || 1; min -= m; max += m;
    const X = (t) => pad.l + ((t - t0) / (t1 - t0)) * (w - pad.l - pad.r);
    const Y = (v) => pad.t + (1 - (v - min) / (max - min)) * (h - pad.t - pad.b);

    // rejilla Y
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (const v of niceTicks(min, max)) {
      ctx.strokeStyle = line; ctx.beginPath(); ctx.moveTo(pad.l, Y(v)); ctx.lineTo(w - pad.r, Y(v)); ctx.stroke();
      ctx.fillStyle = muted; ctx.fillText(`${v}`, pad.l - 8, Y(v));
    }
    // eje X
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    const span = t1 - t0, fmt = span > 2 * 86400_000
      ? { day: '2-digit', month: 'short' } : { hour: '2-digit', minute: '2-digit' };
    const nt = Math.max(2, Math.min(5, Math.floor((w - pad.l - pad.r) / 120)));
    for (let i = 0; i <= nt; i++) {
      const t = t0 + (span * i) / nt;
      ctx.textAlign = i === 0 ? 'left' : i === nt ? 'right' : 'center';
      ctx.fillStyle = muted; ctx.fillText(new Date(t).toLocaleString('es-CO', fmt), X(t), h - pad.b + 8);
    }
    // bandas mín/máx (debajo de las líneas)
    for (const s of this.series) {
      if (!s.band?.length) continue;
      const pts = s.band.filter((b) => b[1] != null && b[2] != null);
      if (pts.length < 2) continue;
      ctx.beginPath();
      pts.forEach((b, i) => (i ? ctx.lineTo(X(b[0]), Y(b[2])) : ctx.moveTo(X(b[0]), Y(b[2]))));
      for (let i = pts.length - 1; i >= 0; i--) ctx.lineTo(X(pts[i][0]), Y(pts[i][1]));
      ctx.closePath();
      ctx.fillStyle = s.color + '2e';
      ctx.fill();
    }
    // series
    for (const s of this.series) {
      ctx.beginPath(); let on = false, prev = null;
      for (const [t, v] of s.data) {
        const gap = prev && t - prev > (s.gapMs || Infinity);
        if (v == null || gap) on = false;
        if (v != null) { on ? ctx.lineTo(X(t), Y(v)) : ctx.moveTo(X(t), Y(v)); on = true; }
        prev = t;
      }
      ctx.strokeStyle = s.color; ctx.lineWidth = 1.8; ctx.stroke();
    }
    // leyenda
    ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    let lx = pad.l + 8;
    for (const s of this.series) {
      ctx.fillStyle = s.color; ctx.fillRect(lx, pad.t + 4, 10, 3);
      ctx.fillStyle = text; ctx.fillText(s.label, lx + 16, pad.t - 1);
      lx += ctx.measureText(s.label).width + 36;
    }
    // cursor
    if (this.hover != null && this.hover > pad.l) {
      const t = t0 + ((this.hover - pad.l) / (w - pad.l - pad.r)) * (t1 - t0);
      ctx.strokeStyle = muted; ctx.setLineDash([3, 4]);
      ctx.beginPath(); ctx.moveTo(this.hover, pad.t); ctx.lineTo(this.hover, h - pad.b); ctx.stroke(); ctx.setLineDash([]);
      const lines = [new Date(t).toLocaleString('es-CO', { dateStyle: 'short', timeStyle: 'medium' })];
      for (const s of this.series) {
        const near = s.data.reduce((a, d) => (Math.abs(d[0] - t) < Math.abs(a[0] - t) ? d : a), s.data[0]);
        if (near && near[1] != null) {
          const b = s.band?.find((x) => x[0] === near[0]);
          lines.push(`${s.label}: ${near[1]} ${this.unit}${b && b[1] != null ? `  (mín ${b[1]}, máx ${b[2]})` : ''}`);
        }
      }
      const bw = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 20;
      const bx = this.hover + bw + 12 > w ? this.hover - bw - 8 : this.hover + 8;
      ctx.fillStyle = css('--surface-2'); ctx.strokeStyle = line;
      ctx.fillRect(bx, pad.t + 20, bw, lines.length * 18 + 10); ctx.strokeRect(bx, pad.t + 20, bw, lines.length * 18 + 10);
      ctx.fillStyle = text;
      lines.forEach((l, i) => ctx.fillText(l, bx + 10, pad.t + 26 + i * 18));
    }
  }
}
