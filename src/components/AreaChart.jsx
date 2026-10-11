import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import { gsap, reducedMotion } from '../lib/motion.js';
import { compact } from '../lib/money.js';

// Gráfica de curvas suaves (estilo de la referencia), hecha en SVG sin librerías
const W = 640;
const H = 220;
const PAD = 18;

function smooth(points) {
  if (points.length < 2) return '';
  let d = `M${points[0][0]},${points[0][1]}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i - 1] || points[i];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[i + 2] || p2;
    const c1x = p1[0] + (p2[0] - p0[0]) / 6;
    const c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6;
    const c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += ` C${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
  }
  return d;
}

export function AreaChart({ labels, series, initialIndex }) {
  const root = useRef(null);
  const [active, setActive] = useState(initialIndex ?? labels.length - 1);
  const max = Math.max(1, ...series.flatMap((s) => s.values)) * 1.15;
  const step = (W - PAD * 2) / Math.max(1, labels.length - 1);
  const toPts = (values) => values.map((v, i) => [PAD + i * step, H - PAD - (v / max) * (H - PAD * 2)]);
  const main = series[0];
  const mainPts = toPts(main.values);
  const ax = mainPts[active]?.[0] ?? 0;
  const ay = mainPts[active]?.[1] ?? 0;

  // Acá se configura la animación de las líneas al aparecer
  useLayoutEffect(() => {
    if (reducedMotion() || !root.current) return;
    const ctx = gsap.context(() => {
      root.current.querySelectorAll('.chart-line').forEach((p) => {
        const len = p.getTotalLength();
        gsap.fromTo(p, { strokeDasharray: len, strokeDashoffset: len }, { strokeDashoffset: 0, duration: 1.2, ease: 'power2.inOut', clearProps: 'strokeDasharray,strokeDashoffset' });
      });
      gsap.from('.chart-fill', { autoAlpha: 0, duration: 0.8, delay: 0.5 });
      gsap.from('.chart-marker', { scale: 0, transformOrigin: 'center', duration: 0.4, delay: 1, ease: 'back.out(3)' });
    }, root.current);
    return () => ctx.revert();
  }, [labels.join()]);

  const pick = (e) => {
    const box = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - box.left) / box.width) * W;
    const i = Math.round((x - PAD) / step);
    setActive(Math.max(0, Math.min(labels.length - 1, i)));
  };

  return (
    <div ref={root} class="chart">
      <div class="chart-plot" onPointerMove={pick} onPointerDown={pick}>
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" class="chart-svg" role="img" aria-label={`${main.name}: ${main.values.map((v, i) => `${labels[i]} ${compact(v)}`).join(', ')}`}>
          <defs>
            <linearGradient id="fill-main" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stop-color="var(--lime)" stop-opacity="0.22" />
              <stop offset="100%" stop-color="var(--lime)" stop-opacity="0" />
            </linearGradient>
            <linearGradient id="band" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stop-color="var(--lime)" stop-opacity="0.18" />
              <stop offset="100%" stop-color="var(--lime)" stop-opacity="0" />
            </linearGradient>
          </defs>
          {labels.map((_, i) => (
            <line x1={PAD + i * step} x2={PAD + i * step} y1={PAD} y2={H} class="chart-grid" />
          ))}
          <rect x={ax - step * 0.22} y={0} width={step * 0.44} height={H} fill="url(#band)" />
          <path class="chart-fill" d={`${smooth(mainPts)} L${mainPts[mainPts.length - 1][0]},${H} L${mainPts[0][0]},${H} Z`} fill="url(#fill-main)" />
          {series
            .slice()
            .reverse()
            .map((s) => (
              <path class="chart-line" d={smooth(toPts(s.values))} stroke={s.color} fill="none" stroke-width="2.4" vector-effect="non-scaling-stroke" />
            ))}
        </svg>
        <span class="chart-marker" style={{ left: `${(ax / W) * 100}%`, top: `${(ay / H) * 100}%` }} />
        <span class="chart-tip num" style={{ left: `${(ax / W) * 100}%`, top: `${(ay / H) * 100}%`, '--tip-x': active === 0 ? '-14%' : active === labels.length - 1 ? '-86%' : '-50%' }}>
          {compact(main.values[active] || 0)}
        </span>
      </div>
      <div class="chart-labels">
        {labels.map((l, i) => (
          <button type="button" class={i === active ? 'is-active' : ''} onClick={() => setActive(i)}>
            {l}
          </button>
        ))}
      </div>
      {series.length > 1 && (
        <div class="chart-legend">
          {series.map((s) => (
            <span>
              <i style={{ background: s.color }} />
              {s.name}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
