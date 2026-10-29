// The start-up animation (2D, on a canvas): a sniper on a rooftop at night, a cut to the
// scope (sway, held breath, the shot, the recoil, the tracer into the distance), and the
// impact opens into a shine that settles over "WEBBLEND XV".
// Click or press any key to skip. About five seconds.

const T = { fadeIn: 300, glint: 520, push: 880, scopeIn: 1300, scope: 1420, shot: 2080, hit: 2420, title: 2700, hold: 4350, end: 4850 };
const RETICLE = '#05060a';

export function playIntro({ onDone } = {}) {
  const reduce = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const wrap = document.createElement('div');
  wrap.className = 'intro';
  wrap.setAttribute('role', 'presentation');
  Object.assign(wrap.style, { position: 'fixed', inset: '0', zIndex: '100000', background: '#05070d', cursor: 'pointer' });
  const cv = document.createElement('canvas');
  Object.assign(cv.style, { width: '100%', height: '100%', display: 'block' });
  const hint = document.createElement('div');
  hint.textContent = 'click to skip';
  Object.assign(hint.style, { position: 'absolute', right: '18px', bottom: '14px', font: '500 11px system-ui, sans-serif', letterSpacing: '0.18em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.35)' });
  wrap.append(cv, hint);
  document.body.append(wrap);
  const ctx = cv.getContext('2d');
  let W = 0, H = 0, dpr = 1;
  const resize = () => { dpr = Math.min(2, window.devicePixelRatio || 1); W = window.innerWidth; H = window.innerHeight; cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); };
  resize();
  window.addEventListener('resize', resize);
  // a fixed skyline (same every time)
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const far = Array.from({ length: 26 }, (_, i) => ({ x: i / 26 + rnd() * 0.02, w: 0.03 + rnd() * 0.04, h: 0.12 + rnd() * 0.22 }));
  const near = Array.from({ length: 16 }, (_, i) => ({ x: i / 16 + rnd() * 0.03, w: 0.05 + rnd() * 0.06, h: 0.08 + rnd() * 0.18, win: Array.from({ length: 14 }, () => [rnd(), rnd(), rnd() > 0.55]) }));
  const stars = Array.from({ length: 90 }, () => [rnd(), rnd() * 0.6, rnd() * 1.2 + 0.3, rnd() * 6]);
  const start = performance.now();
  let skipAt = null, raf = 0, done = false;
  const skip = () => { if (skipAt === null) skipAt = performance.now(); };
  wrap.addEventListener('pointerdown', skip);
  const onKey = (e) => { e.preventDefault(); skip(); };
  window.addEventListener('keydown', onKey, true);
  const finish = () => {
    if (done) return;
    done = true;
    cancelAnimationFrame(raf);
    window.removeEventListener('resize', resize);
    window.removeEventListener('keydown', onKey, true);
    wrap.remove();
    onDone && onDone();
  };
  const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
  const ease = (x) => 1 - Math.pow(1 - clamp(x), 3);
  const easeIn = (x) => Math.pow(clamp(x), 3);
  const phase = (t, a, b) => clamp((t - a) / (b - a));

  const frame = (now) => {
    let t = now - start;
    if (reduce && t < T.title) t = T.title + (t / T.title) * 300; // straight to the title
    let alpha = 1;
    if (skipAt !== null) alpha = 1 - clamp((now - skipAt) / 280);
    else if (t > T.hold) alpha = 1 - phase(t, T.hold, T.end);
    if (alpha <= 0) { finish(); return; }
    wrap.style.opacity = String(alpha);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw(t);
    raf = requestAnimationFrame(frame);
  };

  // the city at night (sky, stars, moon, two rows of buildings)
  const city = (t, u) => {
    const sky = ctx.createLinearGradient(0, 0, 0, H);
    sky.addColorStop(0, '#060814'); sky.addColorStop(0.55, '#141a3a'); sky.addColorStop(1, '#2a1f45');
    ctx.fillStyle = sky; ctx.fillRect(-W, -H, W * 3, H * 3);
    for (const [x, y, r, ph] of stars) { ctx.globalAlpha = 0.35 + 0.35 * Math.sin(t / 400 + ph); ctx.fillStyle = '#cfd8ff'; ctx.fillRect(x * W, y * H, r, r); }
    ctx.globalAlpha = 1;
    const mx = W * 0.82, my = H * 0.2, mr = 42 * u;
    const glow = ctx.createRadialGradient(mx, my, mr * 0.5, mx, my, mr * 4);
    glow.addColorStop(0, 'rgba(190,205,255,0.35)'); glow.addColorStop(1, 'rgba(190,205,255,0)');
    ctx.fillStyle = glow; ctx.fillRect(mx - mr * 4, my - mr * 4, mr * 8, mr * 8);
    ctx.fillStyle = '#e8ecff'; ctx.beginPath(); ctx.arc(mx, my, mr, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#1b2040';
    for (const b of far) ctx.fillRect(b.x * W, H * (0.78 - b.h), b.w * W, H);
    for (const b of near) {
      const x = b.x * W, y = H * (0.86 - b.h), w = b.w * W;
      ctx.fillStyle = '#0d1024'; ctx.fillRect(x, y, w, H);
      ctx.fillStyle = 'rgba(255,200,110,0.75)';
      for (const [wx, wy, on] of b.win) if (on) ctx.fillRect(x + wx * (w - 4 * u), y + 6 * u + wy * (H * b.h - 12 * u), 3 * u, 4 * u);
    }
    // the target: a tower with a beacon on its mast
    const a = AIM(), tw = W * 0.05, top = a.y + H * 0.07;
    ctx.fillStyle = '#10142c'; ctx.fillRect(a.x - tw / 2, top, tw, H);
    ctx.fillStyle = 'rgba(255,214,140,0.85)';
    for (let r = 0; r < 9; r++) for (let c = 0; c < 4; c++) if ((r * 7 + c * 3) % 5 < 3) ctx.fillRect(a.x - tw / 2 + (c + 0.6) * tw / 4.6, top + (r + 0.8) * 9 * u, 2.4 * u, 3.4 * u);
    ctx.strokeStyle = '#1a1f3c'; ctx.lineWidth = 1.4 * u;
    ctx.beginPath(); ctx.moveTo(a.x, top); ctx.lineTo(a.x, a.y);
    ctx.moveTo(a.x - 4 * u, top); ctx.lineTo(a.x, a.y + H * 0.03); ctx.lineTo(a.x + 4 * u, top); ctx.stroke();
    if (t < T.hit) {
      const on = 0.55 + 0.45 * Math.sin(t / 180);
      const lg = ctx.createRadialGradient(a.x, a.y, 0, a.x, a.y, 9 * u);
      lg.addColorStop(0, `rgba(255,90,70,${on})`); lg.addColorStop(0.3, `rgba(255,60,40,${0.6 * on})`); lg.addColorStop(1, 'rgba(255,40,30,0)');
      ctx.fillStyle = lg; ctx.beginPath(); ctx.arc(a.x, a.y, 9 * u, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#ffd0c8'; ctx.beginPath(); ctx.arc(a.x, a.y, 1.2 * u, 0, Math.PI * 2); ctx.fill();
    }
  };
  const AIM = () => ({ x: W * 0.74, y: H * 0.5 });

  // shot 1: the sniper on the rooftop; the camera pushes in on the scope
  const wide = (t, u) => {
    const k = 1.35; // sniper size
    const roofY = H * 0.8;
    const sx = W * 0.14, sy = roofY;
    const scopePt = { x: sx + 150 * u * k, y: sy - 57 * u * k };
    const push = Math.pow(phase(t, T.push, T.scopeIn + 80), 2);
    const zoom = (1 + 0.05 * ease(t / T.push)) * (1 + 5 * push);
    const fx = W / 2 + (scopePt.x - W / 2) * Math.min(1, push * 3), fy = H / 2 + (scopePt.y - H / 2) * Math.min(1, push * 3);
    ctx.save();
    ctx.translate(W / 2, H / 2); ctx.scale(zoom, zoom); ctx.translate(-fx, -fy);
    city(t, u);
    // city glow behind the shooter so the silhouette reads
    const bg = ctx.createRadialGradient(sx + 120 * u, roofY - 30 * u, 0, sx + 120 * u, roofY - 30 * u, 330 * u);
    bg.addColorStop(0, 'rgba(90,110,200,0.32)'); bg.addColorStop(1, 'rgba(90,110,200,0)');
    ctx.fillStyle = bg; ctx.fillRect(sx - 300 * u, roofY - 360 * u, 860 * u, 400 * u);
    ctx.fillStyle = '#05060c'; ctx.fillRect(-W, roofY, W * 0.66 + W, H * 2);
    ctx.fillStyle = '#2a3160'; ctx.fillRect(-W, roofY - 1.5 * u, W * 0.66 + W, 1.5 * u);
    const g = sniper(ctx, sx, sy, u * k, t);
    if (t > T.glint && t < T.scopeIn) {
      const a = Math.sin(phase(t, T.glint, T.glint + 700) * Math.PI);
      if (a > 0) star(ctx, g.scope.x, g.scope.y, 26 * u * a, 'rgba(215,232,255,' + (0.95 * a).toFixed(3) + ')', 0.2);
    }
    ctx.restore();
    // cut to black into the scope
    const b = phase(t, T.scopeIn - 120, T.scopeIn);
    if (b > 0) { ctx.fillStyle = `rgba(0,0,0,${b.toFixed(3)})`; ctx.fillRect(0, 0, W, H); }
  };

  // shot 2: through the scope. The world sways until the breath is held, the round goes, the
  // view kicks, the tracer shrinks into the distance; the impact opens up the frame
  const target = () => ({ x: W / 2, y: H * 0.4 });
  const scope = (t, u) => {
    const c = target();
    const R = Math.min(W, H) * 0.36;
    const hold = ease(phase(t, T.scope + 100, T.shot - 120));
    let ox = (Math.sin(t / 260) * 16 + Math.sin(t / 97) * 2) * u * (1 - hold * 0.92);
    let oy = (Math.cos(t / 340) * 11 + Math.sin(t / 131) * 1.5) * u * (1 - hold * 0.92);
    let flash = 0;
    if (t > T.shot) {
      const d = t - T.shot, r = Math.exp(-d / 130);
      oy -= 70 * u * r * Math.sin(Math.min(Math.PI / 2, d / 28));
      ox += 14 * u * r * Math.sin(d / 40);
      flash = Math.exp(-d / 60);
    }
    // the iris opens after the impact
    const iris = easeIn(phase(t, T.hit + 40, T.hit + 360));
    const Rm = R + (Math.hypot(W, H) - R) * iris;
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
    ctx.save();
    ctx.beginPath(); ctx.arc(c.x, c.y, Rm, 0, Math.PI * 2); ctx.clip();
    // the far side of the city, 4x
    const Z = 3.2, aim = AIM();
    ctx.save();
    ctx.translate(c.x + ox, c.y + oy); ctx.scale(Z, Z); ctx.translate(-aim.x, -aim.y);
    city(t, u);
    ctx.restore();
    // lens: a cool tint, darker at the rim
    const lens = ctx.createRadialGradient(c.x, c.y, R * 0.2, c.x, c.y, R);
    lens.addColorStop(0, 'rgba(120,200,255,0.06)'); lens.addColorStop(0.75, 'rgba(10,20,40,0.15)'); lens.addColorStop(1, 'rgba(0,0,0,0.85)');
    ctx.fillStyle = lens; ctx.fillRect(c.x - R, c.y - R, R * 2, R * 2);
    if (flash > 0.01) { ctx.fillStyle = `rgba(255,190,110,${(0.45 * flash).toFixed(3)})`; ctx.fillRect(0, 0, W, H); }
    // the reticle: fine cross, heavy posts, mil dots, a lit red center
    if (iris < 1) {
      ctx.globalAlpha = 1 - iris;
      ctx.strokeStyle = RETICLE; ctx.fillStyle = RETICLE;
      ctx.lineWidth = 1.2 * u;
      ctx.beginPath(); ctx.moveTo(c.x - R, c.y); ctx.lineTo(c.x + R, c.y); ctx.moveTo(c.x, c.y - R); ctx.lineTo(c.x, c.y + R); ctx.stroke();
      ctx.lineWidth = 5 * u;
      ctx.beginPath();
      ctx.moveTo(c.x - R, c.y); ctx.lineTo(c.x - R * 0.4, c.y); ctx.moveTo(c.x + R * 0.4, c.y); ctx.lineTo(c.x + R, c.y);
      ctx.moveTo(c.x, c.y + R * 0.4); ctx.lineTo(c.x, c.y + R); ctx.stroke();
      for (let i = 1; i <= 4; i++) {
        const d = R * 0.08 * i;
        for (const [dx, dy] of [[d, 0], [-d, 0], [0, d], [0, -d]]) { ctx.beginPath(); ctx.arc(c.x + dx, c.y + dy, 1.8 * u, 0, Math.PI * 2); ctx.fill(); }
      }
      const red = ctx.createRadialGradient(c.x, c.y, 0, c.x, c.y, 7 * u);
      red.addColorStop(0, 'rgba(255,70,50,1)'); red.addColorStop(0.35, 'rgba(255,60,40,0.8)'); red.addColorStop(1, 'rgba(255,40,30,0)');
      ctx.fillStyle = red; ctx.beginPath(); ctx.arc(c.x, c.y, 7 * u, 0, Math.PI * 2); ctx.fill();
      // range card
      ctx.fillStyle = 'rgba(160,255,190,0.75)';
      ctx.font = `600 ${Math.round(10 * u + 4)}px ui-monospace, Menlo, Consolas, monospace`;
      ctx.textAlign = 'left';
      ctx.fillText('RNG 0850 M', c.x - R * 0.62, c.y - R * 0.55);
      ctx.fillText('WND 2.1 →', c.x - R * 0.62, c.y - R * 0.55 + 14 * u + 4);
      ctx.textAlign = 'right';
      ctx.fillText(t < T.shot ? (hold > 0.9 ? 'HOLD' : 'BREATHE') : 'FIRE', c.x + R * 0.62, c.y - R * 0.55);
      ctx.globalAlpha = 1;
    }
    // the tracer: from under the scope into the distance, shrinking
    if (t > T.shot + 30 && t < T.hit + 40) {
      const b = ease(phase(t, T.shot + 30, T.hit));
      const p0 = { x: c.x + 6 * u, y: c.y + R * 1.1 };
      const bx = p0.x + (c.x - p0.x) * b, by = p0.y + (c.y - p0.y) * b;
      const tb = Math.max(0, b - 0.25);
      const tx = p0.x + (c.x - p0.x) * tb, ty = p0.y + (c.y - p0.y) * tb;
      const tr = ctx.createLinearGradient(tx, ty, bx, by);
      tr.addColorStop(0, 'rgba(255,190,110,0)'); tr.addColorStop(1, 'rgba(255,245,220,1)');
      ctx.strokeStyle = tr; ctx.lineCap = 'round'; ctx.lineWidth = (7 - 5.5 * b) * u;
      ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(bx, by); ctx.stroke();
      ctx.fillStyle = '#fff7e0'; ctx.beginPath(); ctx.arc(bx, by, (5 - 3.8 * b) * u, 0, Math.PI * 2); ctx.fill();
    }
    // the beacon bursts
    const sp = phase(t, T.hit - 10, T.hit + 320);
    if (sp > 0 && sp < 1) {
      ctx.strokeStyle = `rgba(255,236,200,${(1 - sp).toFixed(3)})`; ctx.lineWidth = 2 * u; ctx.lineCap = 'round';
      ctx.beginPath();
      for (let i = 0; i < 12; i++) {
        const an = i * 0.5236 + 0.2, r0 = (6 + 90 * ease(sp)) * u, r1 = r0 + (14 + (i % 3) * 8) * u * (1 - sp);
        ctx.moveTo(c.x + Math.cos(an) * r0, c.y + Math.sin(an) * r0); ctx.lineTo(c.x + Math.cos(an) * r1, c.y + Math.sin(an) * r1);
      }
      ctx.stroke();
    }
    ctx.restore();
    // the scope tube's ring
    if (iris < 1) {
      ctx.globalAlpha = 1 - iris;
      ctx.lineWidth = 7 * u; ctx.strokeStyle = '#0b0d14';
      ctx.beginPath(); ctx.arc(c.x, c.y, Rm, 0, Math.PI * 2); ctx.stroke();
      ctx.lineWidth = 1.2 * u; ctx.strokeStyle = 'rgba(140,160,210,0.35)';
      ctx.beginPath(); ctx.arc(c.x, c.y, Rm - 4 * u, 0, Math.PI * 2); ctx.stroke();
      ctx.globalAlpha = 1;
    }
    // fade in from the cut
    const fin = 1 - phase(t, T.scope, T.scope + 140);
    if (fin > 0) { ctx.fillStyle = `rgba(0,0,0,${fin.toFixed(3)})`; ctx.fillRect(0, 0, W, H); }
  };

  const draw = (t) => {
    const u = Math.min(W, H * 1.6) / 1000; // drawing unit
    const tgt = target();
    if (t < T.scope) wide(t, u);
    else {
      const shake = t > T.shot && t < T.shot + 220 ? (1 - (t - T.shot) / 220) * 9 * u : 0;
      ctx.save();
      ctx.translate((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake);
      if (t < T.hit + 400) scope(t, u);
      ctx.restore();
    }
    // the shine: the impact flashes white, then a soft star stays above the name
    if (t > T.hit) {
      const burst = phase(t, T.hit, T.hit + 420);
      const wash = t < T.title + 250 ? Math.sin(Math.min(1, phase(t, T.hit, T.title + 250)) * Math.PI) : 0;
      const bd = ease(phase(t, T.hit + 150, T.title + 200));
      if (bd > 0) {
        const g = ctx.createRadialGradient(W / 2, H * 0.48, 0, W / 2, H * 0.48, Math.max(W, H) * 0.75);
        g.addColorStop(0, `rgba(22,28,54,${bd})`); g.addColorStop(1, `rgba(4,5,10,${bd})`);
        ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
      }
      if (wash > 0) { ctx.fillStyle = `rgba(255,248,230,${(0.92 * wash).toFixed(3)})`; ctx.fillRect(0, 0, W, H); }
      const k = t < T.title ? burst : 0.75 + 0.08 * Math.sin((t - T.title) / 260);
      const R = (90 + 260 * (t < T.title ? burst : 0.35)) * u;
      const halo = ctx.createRadialGradient(tgt.x, tgt.y, 0, tgt.x, tgt.y, R * 1.6);
      halo.addColorStop(0, `rgba(255,236,200,${(0.85 * k).toFixed(3)})`); halo.addColorStop(0.35, `rgba(140,180,255,${(0.35 * k).toFixed(3)})`); halo.addColorStop(1, 'rgba(120,160,255,0)');
      ctx.fillStyle = halo; ctx.fillRect(tgt.x - R * 1.6, tgt.y - R * 1.6, R * 3.2, R * 3.2);
      const fw = W * (0.25 + 0.4 * k);
      const flare = ctx.createLinearGradient(tgt.x - fw, 0, tgt.x + fw, 0);
      flare.addColorStop(0, 'rgba(120,170,255,0)'); flare.addColorStop(0.5, `rgba(235,245,255,${(0.9 * k).toFixed(3)})`); flare.addColorStop(1, 'rgba(120,170,255,0)');
      ctx.fillStyle = flare; ctx.fillRect(tgt.x - fw, tgt.y - 1.6 * u, fw * 2, 3.2 * u);
      star(ctx, tgt.x, tgt.y, (30 + 26 * k) * u, `rgba(255,255,255,${(0.95 * k).toFixed(3)})`, t / 1800);
    }
    // the name, under the shine
    if (t > T.title) {
      const a = ease(phase(t, T.title, T.title + 650));
      const size = Math.max(34, Math.min(W * 0.11, 120));
      const y = H * 0.4 + size * 1.05;
      ctx.save();
      ctx.globalAlpha = a;
      ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
      ctx.font = `900 ${Math.round(size)}px "Segoe UI", system-ui, -apple-system, sans-serif`;
      const name = 'WEBBLEND', xv = ' XV';
      const wName = ctx.measureText(name).width, wXv = ctx.measureText(xv).width;
      const x0 = W / 2 - (wName + wXv) / 2;
      const sc = 1.18 - 0.18 * a;
      ctx.translate(W / 2, y); ctx.scale(sc, sc); ctx.translate(-W / 2, -y);
      ctx.shadowColor = 'rgba(120,170,255,0.55)'; ctx.shadowBlur = 24 * (1.4 - a);
      const fill = ctx.createLinearGradient(0, y - size, 0, y);
      fill.addColorStop(0, '#ffffff'); fill.addColorStop(1, '#a9c4ff');
      ctx.fillStyle = fill; ctx.textAlign = 'left';
      ctx.fillText(name, x0, y);
      // "XV" pops in a beat later, in the app's accent
      const p = ease(phase(t, T.title + 260, T.title + 700));
      if (p > 0) {
        ctx.save();
        const cx = x0 + wName + wXv / 2;
        ctx.translate(cx, y - size * 0.35); ctx.scale(0.6 + 0.4 * p, 0.6 + 0.4 * p); ctx.translate(-cx, -(y - size * 0.35));
        ctx.globalAlpha = a * p;
        ctx.shadowColor = 'rgba(255,170,60,0.7)';
        const ac = ctx.createLinearGradient(0, y - size, 0, y);
        ac.addColorStop(0, '#ffd27a'); ac.addColorStop(1, '#ff8a2a');
        ctx.fillStyle = ac; ctx.fillText(xv, x0 + wName, y);
        ctx.restore();
      }
      // a band of light sweeping across the letters
      const sw = phase(t, T.title + 500, T.title + 1300);
      if (sw > 0 && sw < 1) {
        ctx.globalCompositeOperation = 'source-atop';
        const bx = x0 - 120 + (wName + wXv + 240) * sw;
        const band = ctx.createLinearGradient(bx - 60, 0, bx + 60, 0);
        band.addColorStop(0, 'rgba(255,255,255,0)'); band.addColorStop(0.5, 'rgba(255,255,255,0.9)'); band.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = band;
        ctx.font = `900 ${Math.round(size)}px "Segoe UI", system-ui, -apple-system, sans-serif`;
        ctx.fillText(name + xv, x0, y);
        ctx.globalCompositeOperation = 'source-over';
      }
      ctx.restore();
      // tagline
      const ta = ease(phase(t, T.title + 600, T.title + 1100));
      if (ta > 0) {
        ctx.globalAlpha = ta * 0.8;
        ctx.fillStyle = '#c9d6ff'; ctx.textAlign = 'center';
        ctx.font = `600 ${Math.round(Math.max(11, size * 0.16))}px system-ui, sans-serif`;
        ctx.fillText('A N I M A T O R', W / 2, y + size * 0.42);
        ctx.globalAlpha = 1;
      }
    }
    // fade in from black
    if (t < T.fadeIn) { ctx.fillStyle = `rgba(5,7,13,${(1 - t / T.fadeIn).toFixed(3)})`; ctx.fillRect(0, 0, W, H); }
  };
  raf = requestAnimationFrame(frame);
  return { skip, finish };
}

// a prone sniper silhouette with a rim of moonlight; -> where the muzzle, scope and ejection port are
function sniper(ctx, x, y, u, t) {
  const sil = '#070910', rim = 'rgba(150,178,255,0.8)';
  const breathe = Math.sin(t / 500) * 0.8 * u;
  ctx.save();
  ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  const shape = (fn) => { ctx.beginPath(); fn(); ctx.fillStyle = sil; ctx.fill(); ctx.strokeStyle = rim; ctx.lineWidth = 1.1 * u; ctx.stroke(); };
  // legs stretched out behind
  shape(() => { ctx.moveTo(x - 210 * u, y - 4 * u); ctx.quadraticCurveTo(x - 150 * u, y - 22 * u, x - 70 * u, y - 24 * u); ctx.lineTo(x - 66 * u, y - 6 * u); ctx.quadraticCurveTo(x - 150 * u, y, x - 214 * u, y); ctx.closePath(); });
  shape(() => { ctx.moveTo(x - 200 * u, y - 14 * u); ctx.quadraticCurveTo(x - 140 * u, y - 34 * u, x - 80 * u, y - 32 * u); ctx.lineTo(x - 78 * u, y - 20 * u); ctx.quadraticCurveTo(x - 140 * u, y - 18 * u, x - 202 * u, y - 4 * u); ctx.closePath(); });
  // body
  shape(() => { ctx.ellipse(x - 30 * u, y - 24 * u + breathe, 62 * u, 17 * u, -0.08, 0, Math.PI * 2); });
  // head with a hood, cheek on the stock
  shape(() => { ctx.arc(x + 34 * u, y - 44 * u + breathe, 15 * u, 0, Math.PI * 2); });
  shape(() => { ctx.moveTo(x + 20 * u, y - 50 * u + breathe); ctx.quadraticCurveTo(x + 34 * u, y - 66 * u + breathe, x + 50 * u, y - 50 * u + breathe); ctx.lineTo(x + 46 * u, y - 46 * u + breathe); ctx.quadraticCurveTo(x + 34 * u, y - 58 * u + breathe, x + 24 * u, y - 46 * u + breathe); ctx.closePath(); });
  // arms: one on the grip, one under the stock
  shape(() => { ctx.moveTo(x + 10 * u, y - 30 * u); ctx.lineTo(x + 64 * u, y - 34 * u); ctx.lineTo(x + 66 * u, y - 24 * u); ctx.lineTo(x + 12 * u, y - 18 * u); ctx.closePath(); });
  shape(() => { ctx.moveTo(x - 4 * u, y - 18 * u); ctx.lineTo(x + 30 * u, y - 10 * u); ctx.lineTo(x + 28 * u, y - 2 * u); ctx.lineTo(x - 8 * u, y - 6 * u); ctx.closePath(); });
  // the rifle: stock, receiver, long barrel, scope, bipod
  const ry = y - 38 * u;
  shape(() => { ctx.moveTo(x + 18 * u, ry + 2 * u); ctx.lineTo(x + 60 * u, ry - 4 * u); ctx.lineTo(x + 150 * u, ry - 4 * u); ctx.lineTo(x + 150 * u, ry + 6 * u); ctx.lineTo(x + 64 * u, ry + 8 * u); ctx.lineTo(x + 30 * u, ry + 18 * u); ctx.lineTo(x + 14 * u, ry + 14 * u); ctx.closePath(); });
  shape(() => { ctx.rect(x + 150 * u, ry - 2 * u, 150 * u, 4 * u); });
  shape(() => { ctx.rect(x + 296 * u, ry - 3.5 * u, 16 * u, 7 * u); }); // muzzle brake
  shape(() => { ctx.moveTo(x + 76 * u, ry - 6 * u); ctx.lineTo(x + 84 * u, ry - 16 * u); ctx.lineTo(x + 132 * u, ry - 16 * u); ctx.lineTo(x + 140 * u, ry - 6 * u); ctx.closePath(); });
  shape(() => { ctx.rect(x + 70 * u, ry - 24 * u, 82 * u, 10 * u); ctx.rect(x + 146 * u, ry - 26 * u, 10 * u, 14 * u); }); // scope
  ctx.strokeStyle = sil; ctx.lineWidth = 3 * u;
  ctx.beginPath(); ctx.moveTo(x + 236 * u, ry + 2 * u); ctx.lineTo(x + 222 * u, y); ctx.moveTo(x + 236 * u, ry + 2 * u); ctx.lineTo(x + 250 * u, y); ctx.stroke();
  ctx.restore();
  return { x: x + 314 * u, y: ry, scope: { x: x + 156 * u, y: ry - 19 * u }, eject: { x: x + 100 * u, y: ry - 6 * u } };
}

// a four-point star of light
function star(ctx, x, y, r, color, rot = 0) {
  if (!(r > 0)) return;
  ctx.save();
  ctx.translate(x, y); ctx.rotate(rot);
  ctx.fillStyle = color;
  for (const [a, k] of [[0, 1], [Math.PI / 2, 1], [Math.PI / 4, 0.45], [-Math.PI / 4, 0.45]]) {
    ctx.save(); ctx.rotate(a);
    ctx.beginPath(); ctx.moveTo(-r * k, 0); ctx.quadraticCurveTo(0, -r * 0.06, r * k, 0); ctx.quadraticCurveTo(0, r * 0.06, -r * k, 0); ctx.fill();
    ctx.restore();
  }
  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, r * 0.35);
  g.addColorStop(0, color); g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, r * 0.35, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

// shown unless switched off, and never under automated browsers (tests)
export function shouldPlayIntro(settings) {
  if (typeof location !== 'undefined' && /[?&]intro\b/.test(location.search)) return true; // forced (for previews)
  if (typeof navigator !== 'undefined' && navigator.webdriver) return false;
  if (typeof location !== 'undefined' && /[?&]nointro\b/.test(location.search)) return false;
  return settings.get('introAnimation') !== false;
}
