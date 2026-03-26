// T-Term — Voice Interface (mobile voice-first mode)
// Four visual effects: Ink, Fluid, Aurora, Membrane

let vfxCanvas, vfxCtx, vfxParticles = [], vfxAnimId = null;
let vfxMode = false;
let vfxRecording = false;
let vfxSpeaking = false;
let vfxSessionName = '';
let vfxTapPoint = null;
let vfxEffect = 'ink'; // 'ink' | 'fluid' | 'aurora' | 'membrane'
let vfxTime = 0;

// Colors
const VFX_AI = { r: 56, g: 189, b: 248 };    // cyan
const VFX_USER = { r: 251, g: 191, b: 36 };   // amber
const VFX_IDLE = { r: 80, g: 100, b: 140 };   // muted blue-gray

function rgba(c, a) { return `rgba(${c.r},${c.g},${c.b},${a})`; }

// ══════════════════════════════════════════
//  Particle system (shared across effects)
// ══════════════════════════════════════════
class VfxParticle {
  constructor(x, y, color, intensity, style) {
    this.x = x; this.y = y;
    this.vx = (Math.random() - 0.5) * intensity * 3;
    this.vy = (Math.random() - 0.5) * intensity * 3;
    this.life = 1.0;
    this.decay = 0.003 + Math.random() * 0.006;
    this.size = 2 + Math.random() * 6 * intensity;
    this.color = color;
    this.angle = Math.random() * Math.PI * 2;
    this.angleSpeed = (Math.random() - 0.5) * 0.03;
    this.drift = 0.2 + Math.random() * 0.5;
    this.style = style || 'ink';
  }

  update(t) {
    this.angle += this.angleSpeed;
    this.vx += Math.sin(this.angle + t * 0.001) * this.drift * 0.1;
    this.vy += Math.cos(this.angle * 1.3 + t * 0.0013) * this.drift * 0.1;
    this.vx *= 0.985;
    this.vy *= 0.985;
    this.x += this.vx;
    this.y += this.vy;
    this.life -= this.decay;
    return this.life > 0;
  }
}

function spawnBurst(x, y, color, count, intensity) {
  for (let i = 0; i < count; i++) {
    vfxParticles.push(new VfxParticle(x, y, color, intensity, vfxEffect));
  }
}

// ══════════════════════════════════════════
//  Effect: INK — luminescent ink in water
// ══════════════════════════════════════════
function drawInk(ctx, w, h, t) {
  ctx.fillStyle = 'rgba(0, 0, 0, 0.08)';
  ctx.fillRect(0, 0, w, h);

  vfxParticles.forEach(p => {
    const a = p.life * 0.6;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.size * p.life, 0, Math.PI * 2);
    ctx.fillStyle = rgba(p.color, a);
    ctx.fill();
    if (p.size > 3) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size * p.life * 2.5, 0, Math.PI * 2);
      ctx.fillStyle = rgba(p.color, a * 0.12);
      ctx.fill();
    }
  });

  // Tendrils
  if (vfxParticles.length > 1 && vfxParticles.length < 200) {
    ctx.lineWidth = 0.5;
    for (let i = 0; i < vfxParticles.length; i++) {
      for (let j = i + 1; j < Math.min(i + 4, vfxParticles.length); j++) {
        const a = vfxParticles[i], b = vfxParticles[j];
        const dx = a.x - b.x, dy = a.y - b.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < 50) {
          const alpha = (1 - dist / 50) * Math.min(a.life, b.life) * 0.2;
          ctx.strokeStyle = rgba(a.color, alpha);
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          const mx = (a.x + b.x) / 2 + (Math.random() - 0.5) * 8;
          const my = (a.y + b.y) / 2 + (Math.random() - 0.5) * 8;
          ctx.quadraticCurveTo(mx, my, b.x, b.y);
          ctx.stroke();
        }
      }
    }
  }
}

// ══════════════════════════════════════════
//  Effect: FLUID — dark rippling water surface
// ══════════════════════════════════════════
let fluidField = null;
function drawFluid(ctx, w, h, t) {
  ctx.fillStyle = 'rgba(0, 0, 0, 0.08)';
  ctx.fillRect(0, 0, w, h);

  // Ripple rings
  const intensity = vfxSpeaking ? 1.5 : (vfxRecording ? 1.0 : 0.3);
  const color = vfxSpeaking ? VFX_AI : (vfxRecording ? VFX_USER : VFX_IDLE);
  const cx = w / 2, cy = h / 2;

  // Concentric ripples
  for (let r = 0; r < 5; r++) {
    const radius = ((t * 0.03 + r * 60) % (Math.max(w, h) * 0.7));
    const alpha = (1 - radius / (Math.max(w, h) * 0.7)) * 0.15 * intensity;
    if (alpha <= 0) continue;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.strokeStyle = rgba(color, alpha);
    ctx.lineWidth = 1.5 + intensity;
    ctx.stroke();
  }

  // Surface distortion particles
  vfxParticles.forEach(p => {
    const a = p.life * 0.4;
    const s = p.size * p.life;
    // Horizontal streak (water-like)
    ctx.beginPath();
    ctx.ellipse(p.x, p.y, s * 2, s * 0.6, p.angle, 0, Math.PI * 2);
    ctx.fillStyle = rgba(p.color, a);
    ctx.fill();
  });

  // Reflection line
  const reflectY = h * 0.5 + Math.sin(t * 0.002) * 5;
  ctx.beginPath();
  ctx.moveTo(0, reflectY);
  for (let x = 0; x <= w; x += 4) {
    ctx.lineTo(x, reflectY + Math.sin(x * 0.02 + t * 0.003) * (2 + intensity * 3));
  }
  ctx.strokeStyle = rgba(color, 0.08);
  ctx.lineWidth = 1;
  ctx.stroke();
}

// ══════════════════════════════════════════
//  Effect: AURORA — northern lights
// ══════════════════════════════════════════
function drawAurora(ctx, w, h, t) {
  ctx.fillStyle = 'rgba(0, 0, 0, 0.08)';
  ctx.fillRect(0, 0, w, h);

  const intensity = vfxSpeaking ? 1.5 : (vfxRecording ? 1.0 : 0.4);
  const color = vfxSpeaking ? VFX_AI : (vfxRecording ? VFX_USER : VFX_IDLE);

  // Aurora curtains
  for (let c = 0; c < 3; c++) {
    ctx.beginPath();
    const yBase = h * (0.25 + c * 0.15);
    ctx.moveTo(0, yBase);
    for (let x = 0; x <= w; x += 3) {
      const wave1 = Math.sin(x * 0.008 + t * 0.001 + c * 2) * 40 * intensity;
      const wave2 = Math.sin(x * 0.015 + t * 0.0018 + c) * 20 * intensity;
      const wave3 = Math.sin(x * 0.003 + t * 0.0005) * 60;
      ctx.lineTo(x, yBase + wave1 + wave2 + wave3);
    }
    ctx.lineTo(w, h);
    ctx.lineTo(0, h);
    ctx.closePath();

    const grad = ctx.createLinearGradient(0, yBase - 80, 0, h);
    const hueShift = c * 30;
    const r = Math.min(255, color.r + hueShift * (c === 1 ? 1 : 0));
    const g = Math.min(255, color.g - hueShift * 0.5);
    const b = Math.min(255, color.b + hueShift * (c === 2 ? 1 : 0));
    grad.addColorStop(0, `rgba(${r},${g},${b},${0.06 * intensity})`);
    grad.addColorStop(0.3, `rgba(${r},${g},${b},${0.03 * intensity})`);
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = grad;
    ctx.fill();
  }

  // Bright streaks
  vfxParticles.forEach(p => {
    const a = p.life * 0.3;
    ctx.beginPath();
    ctx.moveTo(p.x - p.size * 3, p.y);
    ctx.lineTo(p.x + p.size * 3, p.y + Math.sin(p.angle) * 3);
    ctx.strokeStyle = rgba(p.color, a);
    ctx.lineWidth = p.size * p.life * 0.8;
    ctx.lineCap = 'round';
    ctx.stroke();
  });
}

// ══════════════════════════════════════════
//  Effect: MEMBRANE — bioluminescent veins
// ══════════════════════════════════════════
let membraneVeins = [];
function initMembraneVeins(w, h) {
  membraneVeins = [];
  for (let i = 0; i < 12; i++) {
    const points = [];
    let x = Math.random() * w, y = Math.random() * h;
    for (let j = 0; j < 8; j++) {
      points.push({ x, y });
      x += (Math.random() - 0.5) * w * 0.3;
      y += (Math.random() - 0.5) * h * 0.3;
    }
    membraneVeins.push({ points, phase: Math.random() * Math.PI * 2, speed: 0.001 + Math.random() * 0.002 });
  }
}

function drawMembrane(ctx, w, h, t) {
  ctx.fillStyle = 'rgba(0, 0, 0, 0.08)';
  ctx.fillRect(0, 0, w, h);

  if (membraneVeins.length === 0) initMembraneVeins(w, h);

  const intensity = vfxSpeaking ? 1.5 : (vfxRecording ? 1.0 : 0.3);
  const color = vfxSpeaking ? VFX_AI : (vfxRecording ? VFX_USER : VFX_IDLE);

  // Pulsing membrane background
  const pulseAlpha = 0.02 + Math.sin(t * 0.003) * 0.01 * intensity;
  const grad = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w * 0.6);
  grad.addColorStop(0, rgba(color, pulseAlpha));
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);

  // Veins
  for (const vein of membraneVeins) {
    const pulse = Math.sin(t * vein.speed + vein.phase);
    const alpha = (0.08 + pulse * 0.06) * intensity;
    const width = 1 + pulse * 0.5 + intensity * 0.5;

    ctx.beginPath();
    ctx.moveTo(
      vein.points[0].x + Math.sin(t * 0.001 + vein.phase) * 10,
      vein.points[0].y + Math.cos(t * 0.0013 + vein.phase) * 10
    );
    for (let i = 1; i < vein.points.length; i++) {
      const p = vein.points[i];
      const ox = Math.sin(t * 0.001 + vein.phase + i) * 15;
      const oy = Math.cos(t * 0.0012 + vein.phase + i * 1.3) * 15;
      ctx.lineTo(p.x + ox, p.y + oy);
    }
    ctx.strokeStyle = rgba(color, alpha);
    ctx.lineWidth = width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke();

    // Pulse traveling along vein
    const pulsePos = ((t * 0.002 + vein.phase) % 1);
    const idx = Math.floor(pulsePos * (vein.points.length - 1));
    if (idx < vein.points.length) {
      const pp = vein.points[idx];
      ctx.beginPath();
      ctx.arc(
        pp.x + Math.sin(t * 0.001 + vein.phase + idx) * 15,
        pp.y + Math.cos(t * 0.0012 + vein.phase + idx * 1.3) * 15,
        3 + intensity * 2, 0, Math.PI * 2
      );
      ctx.fillStyle = rgba(color, 0.3 * intensity);
      ctx.fill();
    }
  }

  // Touch response — tendrils reaching toward tap point
  if (vfxTapPoint) {
    for (let i = 0; i < 3; i++) {
      const angle = t * 0.003 + i * Math.PI * 2 / 3;
      const dist = 40 + Math.sin(t * 0.005 + i) * 20;
      ctx.beginPath();
      ctx.moveTo(vfxTapPoint.x, vfxTapPoint.y);
      ctx.lineTo(
        vfxTapPoint.x + Math.cos(angle) * dist,
        vfxTapPoint.y + Math.sin(angle) * dist
      );
      ctx.strokeStyle = rgba(VFX_USER, 0.2);
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  }

  // Particles as bioluminescent sparks
  vfxParticles.forEach(p => {
    const a = p.life * 0.5;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.size * p.life * 0.7, 0, Math.PI * 2);
    ctx.fillStyle = rgba(p.color, a);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.size * p.life * 2, 0, Math.PI * 2);
    ctx.fillStyle = rgba(p.color, a * 0.1);
    ctx.fill();
  });
}

// ══════════════════════════════════════════
//  Core system
// ══════════════════════════════════════════
function vfxInit() {
  const container = document.getElementById('ink-view');
  if (!container) return;

  if (!vfxCanvas) {
    vfxCanvas = document.createElement('canvas');
    vfxCanvas.id = 'ink-canvas';
    vfxCanvas.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;touch-action:none;';
    container.insertBefore(vfxCanvas, container.firstChild);
    vfxCtx = vfxCanvas.getContext('2d');

    function resize() {
      const dpr = devicePixelRatio || 1;
      vfxCanvas.width = container.clientWidth * dpr;
      vfxCanvas.height = container.clientHeight * dpr;
      vfxCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
      membraneVeins = []; // Re-init veins on resize
    }
    resize();
    window.addEventListener('resize', resize);

    // Tap to record — only on canvas, not overlay
    vfxCanvas.addEventListener('touchstart', vfxHandleTap, { passive: false });
    vfxCanvas.addEventListener('click', vfxHandleTap);
  }

  // Clear canvas
  vfxCtx.fillStyle = '#000';
  vfxCtx.fillRect(0, 0, vfxCanvas.clientWidth, vfxCanvas.clientHeight);
  vfxParticles = [];

  if (!vfxAnimId) vfxAnimate(0);

  // Ambient
  if (!vfxInit._ambientTimer) {
    vfxInit._ambientTimer = setInterval(() => {
      if (vfxMode && !vfxSpeaking && !vfxRecording) vfxSpawnAmbient();
    }, 200);
  }
}

function vfxHandleTap(e) {
  e.preventDefault();
  e.stopPropagation();
  const rect = vfxCanvas.getBoundingClientRect();
  const x = (e.touches ? e.touches[0].clientX : e.clientX) - rect.left;
  const y = (e.touches ? e.touches[0].clientY : e.clientY) - rect.top;

  if (vfxRecording) {
    vfxRecording = false;
    vfxTapPoint = null;
    const status = document.getElementById('ink-status');
    if (status) status.textContent = '';
    if (typeof _sttRecording !== 'undefined' && _sttRecording) {
      const textarea = document.getElementById('mobile-input');
      _sttStop(null, textarea, false).then(() => {
        if (typeof mobileSendText === 'function') mobileSendText();
      });
    }
  } else {
    vfxRecording = true;
    vfxTapPoint = { x, y };
    const status = document.getElementById('ink-status');
    if (status) status.textContent = 'LISTENING...';
    spawnBurst(x, y, VFX_USER, 20, 1.5);
    const textarea = document.getElementById('mobile-input');
    if (typeof _sttStart === 'function') _sttStart(null, textarea);
  }
}

function vfxSpawnAmbient() {
  if (!vfxCanvas) return;
  const w = vfxCanvas.clientWidth, h = vfxCanvas.clientHeight;
  const cx = w / 2 + (Math.random() - 0.5) * w * 0.4;
  const cy = h / 2 + (Math.random() - 0.5) * h * 0.4;
  spawnBurst(cx, cy, VFX_IDLE, 2, 0.3);
}

function vfxSpawnAI(intensity) {
  if (!vfxCanvas) return;
  const w = vfxCanvas.clientWidth, h = vfxCanvas.clientHeight;
  spawnBurst(
    w / 2 + (Math.random() - 0.5) * 60,
    h * 0.4 + (Math.random() - 0.5) * 40,
    VFX_AI, Math.ceil(intensity * 8), intensity
  );
}

function vfxSpawnUser() {
  if (!vfxTapPoint) return;
  spawnBurst(
    vfxTapPoint.x + (Math.random() - 0.5) * 30,
    vfxTapPoint.y + (Math.random() - 0.5) * 30,
    VFX_USER, 3, 0.8
  );
}

function vfxAnimate(t) {
  if (!vfxCtx || !vfxCanvas || !vfxMode) { vfxAnimId = null; return; }
  vfxTime = t;
  const w = vfxCanvas.clientWidth, h = vfxCanvas.clientHeight;

  if (vfxSpeaking) vfxSpawnAI(0.8);
  if (vfxRecording) vfxSpawnUser();

  // Update particles
  vfxParticles = vfxParticles.filter(p => p.update(t));

  // Draw current effect
  switch (vfxEffect) {
    case 'ink': drawInk(vfxCtx, w, h, t); break;
    case 'fluid': drawFluid(vfxCtx, w, h, t); break;
    case 'aurora': drawAurora(vfxCtx, w, h, t); break;
    case 'membrane': drawMembrane(vfxCtx, w, h, t); break;
  }

  vfxAnimId = requestAnimationFrame(vfxAnimate);
}

// ══════════════════════════════════════════
//  Public API
// ══════════════════════════════════════════
function inkNotifySpeakStart() { vfxSpeaking = true; }
function inkNotifySpeakStop() { vfxSpeaking = false; }


function inkShow(projectName) {
  vfxSessionName = projectName;
  vfxMode = true;
  const view = document.getElementById('ink-view');
  if (view) {
    view.style.display = 'flex';
    const label = document.getElementById('ink-project');
    if (label) label.textContent = projectName;
    const effectLabel = document.getElementById('ink-effect-label');
    if (effectLabel) effectLabel.textContent = vfxEffect.toUpperCase();
  }
  document.getElementById('mobile-chat').style.display = 'none';
  // Defer canvas init to next frame so the view is rendered first (prevents freeze)
  requestAnimationFrame(() => vfxInit());
}

function inkHide() {
  vfxMode = false;
  const view = document.getElementById('ink-view');
  if (view) view.style.display = 'none';
}

function inkToggleMode() {
  if (vfxMode) {
    inkHide();
    document.getElementById('mobile-chat').style.display = 'flex';
  } else {
    inkShow(mobileProject || '');
  }
}

function inkCycleEffect() {
  const effects = ['ink', 'fluid', 'aurora', 'membrane'];
  const idx = effects.indexOf(vfxEffect);
  vfxEffect = effects[(idx + 1) % effects.length];
  // Clear canvas for new effect
  if (vfxCtx && vfxCanvas) {
    vfxCtx.fillStyle = '#000';
    vfxCtx.fillRect(0, 0, vfxCanvas.clientWidth, vfxCanvas.clientHeight);
  }
  vfxParticles = [];
  membraneVeins = [];
  const label = document.getElementById('ink-effect-label');
  if (label) label.textContent = vfxEffect.toUpperCase();
}
