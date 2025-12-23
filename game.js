(() => {
    const stage = document.getElementById('game-stage');
    const canvas = document.getElementById('game-canvas');
    const overlay = document.getElementById('game-overlay');
    const overlayTitle = document.getElementById('overlay-title');
    const overlayMessage = document.getElementById('overlay-message');
    const btnStart = document.getElementById('btn-start');
    const btnFocus = document.getElementById('btn-focus');
    const savedEl = document.getElementById('stat-saved');
    const streakEl = document.getElementById('stat-streak');
    const livesEl = document.getElementById('stat-lives');
    const clockEl = document.getElementById('stat-clock');

    if (!stage || !canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
    const lerp = (a, b, t) => a + (b - a) * t;
    const rand = (min, max) => min + Math.random() * (max - min);

    let reducedMotion = false;
    try {
        const mq = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)');
        reducedMotion = !!(mq && mq.matches);
        if (mq && mq.addEventListener) {
            mq.addEventListener('change', (e) => {
                reducedMotion = !!e.matches;
            });
        }
    } catch (_) {}

    // Player position:
    // 0 = top-left, 1 = bottom-left, 2 = top-right, 3 = bottom-right
    const state = {
        running: false,
        paused: false,
        score: 0,
        streak: 0,
        lives: 3,
        selected: 3,
        lastTs: 0,
        elapsed: 0,
        spawnTimer: 0.7,
        lastLane: -1,
        tokens: [],
        particles: [],
        handAngle: 0,
        handAngleTarget: 0,
        dpr: 1,
        w: 1,
        h: 1,
    };

    const posToAngles = [-Math.PI * 0.75, Math.PI * 0.75, -Math.PI * 0.25, Math.PI * 0.25];

    const setSelected = (pos) => {
        state.selected = clamp(pos | 0, 0, 3);
        state.handAngleTarget = posToAngles[state.selected];
    };

    const formatSaved = (seconds) => {
        if (seconds < 60) return `${seconds}s`;
        const m = Math.floor(seconds / 60);
        const s = seconds % 60;
        return `${m}m ${String(s).padStart(2, '0')}s`;
    };

    const updateHud = () => {
        if (savedEl) savedEl.textContent = formatSaved(state.score);
        if (streakEl) streakEl.textContent = String(state.streak);
        if (livesEl) livesEl.textContent = String(state.lives);
    };

    const updateClock = () => {
        if (!clockEl) return;
        const d = new Date();
        const hh = String(d.getHours()).padStart(2, '0');
        const mm = String(d.getMinutes()).padStart(2, '0');
        const ss = String(d.getSeconds()).padStart(2, '0');
        clockEl.textContent = `${hh}:${mm}:${ss}`;
    };
    updateClock();
    setInterval(updateClock, 1000);

    // Load brand icon (optional; game works without it)
    const brandIcon = new Image();
    brandIcon.decoding = 'async';
    brandIcon.src = './assets/colorIcon.png';

    const playShake = () => {
        stage.classList.remove('shake');
        // reflow
        void stage.offsetWidth;
        stage.classList.add('shake');
    };

    const quad = (p0, p1, p2, t) => {
        const u = 1 - t;
        const x = u * u * p0.x + 2 * u * t * p1.x + t * t * p2.x;
        const y = u * u * p0.y + 2 * u * t * p1.y + t * t * p2.y;
        return { x, y };
    };

    const makeLanes = (w, h) => {
        // Normalized control points for four curved "time rails"
        const lanesN = [
            { p0: { x: 0.14, y: 0.18 }, p1: { x: 0.30, y: 0.14 }, p2: { x: 0.40, y: 0.34 } }, // TL
            { p0: { x: 0.14, y: 0.82 }, p1: { x: 0.30, y: 0.86 }, p2: { x: 0.40, y: 0.66 } }, // BL
            { p0: { x: 0.86, y: 0.18 }, p1: { x: 0.70, y: 0.14 }, p2: { x: 0.60, y: 0.34 } }, // TR
            { p0: { x: 0.86, y: 0.82 }, p1: { x: 0.70, y: 0.86 }, p2: { x: 0.60, y: 0.66 } }, // BR
        ];

        return lanesN.map((ln) => ({
            p0: { x: ln.p0.x * w, y: ln.p0.y * h },
            p1: { x: ln.p1.x * w, y: ln.p1.y * h },
            p2: { x: ln.p2.x * w, y: ln.p2.y * h },
        }));
    };

    const tokenLabel = () => {
        const d = new Date();
        const s = d.getSeconds();
        const n = (s + Math.floor(Math.random() * 12)) % 60;
        return String(n).padStart(2, '0');
    };

    const spawnToken = () => {
        const difficulty = 1 + state.score * 0.035;
        const minInterval = 0.34;
        const maxInterval = 1.05;
        const interval = clamp(maxInterval / difficulty, minInterval, maxInterval);
        state.spawnTimer = rand(interval * 0.75, interval * 1.1);

        let lane = Math.floor(Math.random() * 4);
        if (lane === state.lastLane && Math.random() < 0.65) lane = (lane + 1 + Math.floor(Math.random() * 3)) % 4;
        state.lastLane = lane;

        const speed = clamp(0.62 + state.score * 0.01 + rand(-0.08, 0.08), 0.55, 1.45);
        state.tokens.push({
            lane,
            t: 0,
            speed,
            label: tokenLabel(),
            wobble: rand(0, Math.PI * 2),
        });
    };

    const burst = (x, y, color, power = 1) => {
        const count = 10 + Math.floor(8 * power);
        for (let i = 0; i < count; i++) {
            const a = rand(0, Math.PI * 2);
            const sp = rand(30, 140) * power;
            state.particles.push({
                x,
                y,
                vx: Math.cos(a) * sp,
                vy: Math.sin(a) * sp,
                life: rand(0.4, 0.8),
                maxLife: 1,
                r: rand(1.6, 3.2),
                color,
            });
        }
    };

    const reset = () => {
        state.running = true;
        state.paused = false;
        state.score = 0;
        state.streak = 0;
        state.lives = 3;
        state.tokens = [];
        state.particles = [];
        state.elapsed = 0;
        state.spawnTimer = 0.6;
        state.lastLane = -1;
        state.lastTs = 0;
        setSelected(3);
        updateHud();
    };

    const showOverlay = ({ title, message, buttonLabel }) => {
        if (overlayTitle) overlayTitle.textContent = title;
        if (overlayMessage) overlayMessage.textContent = message;
        if (btnStart) btnStart.textContent = buttonLabel;
        if (overlay) overlay.hidden = false;
    };

    const hideOverlay = () => {
        if (overlay) overlay.hidden = true;
    };

    const togglePause = () => {
        if (!state.running) return;
        state.paused = !state.paused;
        if (state.paused) {
            showOverlay({
                title: 'Paused',
                message: 'Press Space to resume.',
                buttonLabel: 'Resume',
            });
        } else {
            hideOverlay();
        }
    };

    const endGame = () => {
        state.running = false;
        state.paused = false;
        showOverlay({
            title: 'Out of time',
            message: `You saved ${formatSaved(state.score)}. Press Start to play again.`,
            buttonLabel: 'Play again',
        });
    };

    const resize = () => {
        const rect = stage.getBoundingClientRect();
        state.w = Math.max(1, Math.floor(rect.width));
        state.h = Math.max(1, Math.floor(rect.height));
        state.dpr = Math.min(window.devicePixelRatio || 1, 2);
        canvas.width = Math.floor(state.w * state.dpr);
        canvas.height = Math.floor(state.h * state.dpr);
        ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
    };

    const ro = new ResizeObserver(resize);
    ro.observe(stage);
    window.addEventListener('resize', resize, { passive: true });
    resize();

    const drawBackground = (w, h, t) => {
        const tm = reducedMotion ? 0 : t;
        // Subtle grid + vignette
        ctx.clearRect(0, 0, w, h);

        const g = ctx.createLinearGradient(0, 0, 0, h);
        g.addColorStop(0, 'rgba(255, 255, 255, 0.11)');
        g.addColorStop(1, 'rgba(255, 255, 255, 0.03)');
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, w, h);

        // Grid
        const spacing = Math.max(26, Math.floor(Math.min(w, h) * 0.06));
        ctx.globalAlpha = 0.10;
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1;
        for (let x = 0; x < w + spacing; x += spacing) {
            ctx.beginPath();
            ctx.moveTo(x + (tm * 14) % spacing, 0);
            ctx.lineTo(x + (tm * 14) % spacing, h);
            ctx.stroke();
        }
        for (let y = 0; y < h + spacing; y += spacing) {
            ctx.beginPath();
            ctx.moveTo(0, y - (tm * 12) % spacing);
            ctx.lineTo(w, y - (tm * 12) % spacing);
            ctx.stroke();
        }
        ctx.globalAlpha = 1;

        // Vignette
        const vg = ctx.createRadialGradient(w * 0.5, h * 0.5, Math.min(w, h) * 0.05, w * 0.5, h * 0.5, Math.max(w, h) * 0.65);
        vg.addColorStop(0, 'rgba(0, 0, 0, 0.0)');
        vg.addColorStop(1, 'rgba(0, 0, 0, 0.25)');
        ctx.fillStyle = vg;
        ctx.fillRect(0, 0, w, h);
    };

    const drawLanes = (lanes) => {
        // Glow underlay
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';

        for (let i = 0; i < lanes.length; i++) {
            const ln = lanes[i];
            ctx.globalAlpha = 0.18;
            ctx.strokeStyle = i === state.selected ? '#55b761' : '#ffffff';
            ctx.lineWidth = 10;
            ctx.beginPath();
            ctx.moveTo(ln.p0.x, ln.p0.y);
            ctx.quadraticCurveTo(ln.p1.x, ln.p1.y, ln.p2.x, ln.p2.y);
            ctx.stroke();
        }

        for (let i = 0; i < lanes.length; i++) {
            const ln = lanes[i];
            ctx.globalAlpha = 0.35;
            ctx.strokeStyle = i === state.selected ? '#55b761' : 'rgba(255,255,255,0.75)';
            ctx.lineWidth = 3;
            ctx.beginPath();
            ctx.moveTo(ln.p0.x, ln.p0.y);
            ctx.quadraticCurveTo(ln.p1.x, ln.p1.y, ln.p2.x, ln.p2.y);
            ctx.stroke();
        }
        ctx.globalAlpha = 1;

        // End "catch" markers
        for (let i = 0; i < lanes.length; i++) {
            const p = lanes[i].p2;
            ctx.globalAlpha = 0.9;
            ctx.fillStyle = i === state.selected ? 'rgba(85,183,97,0.85)' : 'rgba(255,255,255,0.55)';
            ctx.beginPath();
            ctx.arc(p.x, p.y, 7.5, 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.globalAlpha = 1;
    };

    const drawClock = (cx, cy, r, t) => {
        const tm = reducedMotion ? 0 : t;
        // Outer ring
        ctx.globalAlpha = 0.95;
        ctx.fillStyle = 'rgba(15, 23, 42, 0.65)';
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.20)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(cx, cy, r + 10, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();

        // Inner face
        ctx.fillStyle = 'rgba(255, 255, 255, 0.10)';
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.fill();

        // Ticks
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.40)';
        for (let i = 0; i < 12; i++) {
            const a = (i / 12) * Math.PI * 2 + tm * 0.15;
            const x0 = cx + Math.cos(a) * (r - 4);
            const y0 = cy + Math.sin(a) * (r - 4);
            const x1 = cx + Math.cos(a) * (r - 14);
            const y1 = cy + Math.sin(a) * (r - 14);
            ctx.lineWidth = i % 3 === 0 ? 3 : 2;
            ctx.beginPath();
            ctx.moveTo(x0, y0);
            ctx.lineTo(x1, y1);
            ctx.stroke();
        }

        // Center cap
        ctx.fillStyle = 'rgba(85,183,97,0.95)';
        ctx.beginPath();
        ctx.arc(cx, cy, 5.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
    };

    const drawHand = (cx, cy, r) => {
        state.handAngle = lerp(state.handAngle, state.handAngleTarget, reducedMotion ? 1 : 0.18);
        const a = state.handAngle;
        const hx = cx + Math.cos(a) * (r + 22);
        const hy = cy + Math.sin(a) * (r + 22);

        ctx.lineCap = 'round';
        ctx.globalAlpha = 0.95;
        ctx.strokeStyle = 'rgba(85,183,97,0.9)';
        ctx.lineWidth = 10;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(hx, hy);
        ctx.stroke();

        ctx.strokeStyle = 'rgba(255,255,255,0.62)';
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(hx, hy);
        ctx.stroke();

        // Catch hook
        ctx.globalAlpha = 0.95;
        ctx.strokeStyle = 'rgba(255,255,255,0.92)';
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.arc(hx, hy, 10, a - Math.PI * 0.65, a + Math.PI * 0.65);
        ctx.stroke();
        ctx.globalAlpha = 1;
    };

    const drawToken = (x, y, r, label, wobbleT) => {
        // Outer
        const glow = ctx.createRadialGradient(x, y, r * 0.2, x, y, r * 1.8);
        glow.addColorStop(0, 'rgba(85,183,97,0.35)');
        glow.addColorStop(1, 'rgba(85,183,97,0.0)');
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.arc(x, y, r * 1.7, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = 'rgba(255,255,255,0.92)';
        ctx.strokeStyle = 'rgba(15, 23, 42, 0.40)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();

        // Tiny clock hands
        const a0 = wobbleT;
        const a1 = wobbleT * 2.2 + 1.2;
        ctx.strokeStyle = 'rgba(15, 23, 42, 0.65)';
        ctx.lineCap = 'round';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + Math.cos(a0) * r * 0.55, y + Math.sin(a0) * r * 0.55);
        ctx.stroke();
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + Math.cos(a1) * r * 0.32, y + Math.sin(a1) * r * 0.32);
        ctx.stroke();

        // Label (seconds)
        ctx.fillStyle = 'rgba(15, 23, 42, 0.78)';
        ctx.font = `800 ${Math.max(10, Math.floor(r * 0.9))}px -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Arial, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, x, y + r * 0.05);
    };

    const drawParticles = (dt) => {
        for (let i = state.particles.length - 1; i >= 0; i--) {
            const p = state.particles[i];
            p.life -= dt;
            if (p.life <= 0) {
                state.particles.splice(i, 1);
                continue;
            }
            p.vy += 240 * dt;
            p.x += p.vx * dt;
            p.y += p.vy * dt;
            p.vx *= 0.98;
            p.vy *= 0.98;

            const a = clamp(p.life / 0.8, 0, 1);
            ctx.globalAlpha = a;
            ctx.fillStyle = p.color;
            ctx.beginPath();
            ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.globalAlpha = 1;
    };

    const step = (dt) => {
        state.elapsed += dt;

        // Spawn
        state.spawnTimer -= dt;
        if (state.spawnTimer <= 0) spawnToken();

        // Update tokens
        const lanes = makeLanes(state.w, state.h);
        for (let i = state.tokens.length - 1; i >= 0; i--) {
            const tk = state.tokens[i];
            tk.t += dt * tk.speed;
            tk.wobble += dt * (reducedMotion ? 0 : 2.4);

            if (tk.t >= 1) {
                const end = lanes[tk.lane].p2;
                if (tk.lane === state.selected) {
                    // Caught
                    state.tokens.splice(i, 1);
                    state.score += 1;
                    state.streak += 1;
                    burst(end.x, end.y, 'rgba(85,183,97,0.95)', 1);
                    updateHud();
                } else {
                    // Missed
                    state.tokens.splice(i, 1);
                    state.lives -= 1;
                    state.streak = 0;
                    burst(end.x, end.y, 'rgba(255,255,255,0.75)', 0.9);
                    playShake();
                    updateHud();
                    if (state.lives <= 0) endGame();
                }
            }
        }
    };

    const draw = (dt) => {
        const w = state.w;
        const h = state.h;
        const t = state.elapsed;
        const lanes = makeLanes(w, h);

        drawBackground(w, h, t);
        drawLanes(lanes);

        const cx = w * 0.5;
        const cy = h * 0.5;
        const clockR = Math.min(w, h) * 0.11;

        // Tokens under the hand for depth
        for (const tk of state.tokens) {
            const ln = lanes[tk.lane];
            const p = quad(ln.p0, ln.p1, ln.p2, tk.t);
            const r = clamp(Math.min(w, h) * 0.028, 10, 18);
            drawToken(p.x, p.y, r, tk.label, tk.wobble);
        }

        drawClock(cx, cy, clockR, t);
        drawHand(cx, cy, clockR);

        // Tiny brand mark in the center (optional)
        if (brandIcon.complete && brandIcon.naturalWidth > 0) {
            const iw = clockR * 1.1;
            const ih = clockR * 1.1;
            ctx.globalAlpha = 0.9;
            ctx.drawImage(brandIcon, cx - iw / 2, cy - ih / 2, iw, ih);
            ctx.globalAlpha = 1;
        }

        drawParticles(dt);

        // Pause badge (when overlay hidden but paused due to visibility)
        if (state.running && state.paused && overlay && overlay.hidden) {
            ctx.globalAlpha = 0.8;
            ctx.fillStyle = 'rgba(15, 23, 42, 0.55)';
            ctx.strokeStyle = 'rgba(255,255,255,0.18)';
            ctx.lineWidth = 1;
            ctx.beginPath();
            const bw = 130;
            const bh = 36;
            const x = w - bw - 16;
            const y = 16;
            ctx.roundRect(x, y, bw, bh, 12);
            ctx.fill();
            ctx.stroke();
            ctx.fillStyle = 'rgba(255,255,255,0.85)';
            ctx.font = '700 13px -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Arial, sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText('Paused', x + bw / 2, y + bh / 2);
            ctx.globalAlpha = 1;
        }
    };

    // Polyfill for roundRect (Safari older)
    if (!CanvasRenderingContext2D.prototype.roundRect) {
        // eslint-disable-next-line no-extend-native
        CanvasRenderingContext2D.prototype.roundRect = function (x, y, w, h, r) {
            const rr = Array.isArray(r) ? r : [r, r, r, r];
            const [r1, r2, r3, r4] = rr.map((v) => clamp(v, 0, Math.min(w, h) / 2));
            this.beginPath();
            this.moveTo(x + r1, y);
            this.lineTo(x + w - r2, y);
            this.quadraticCurveTo(x + w, y, x + w, y + r2);
            this.lineTo(x + w, y + h - r3);
            this.quadraticCurveTo(x + w, y + h, x + w - r3, y + h);
            this.lineTo(x + r4, y + h);
            this.quadraticCurveTo(x, y + h, x, y + h - r4);
            this.lineTo(x, y + r1);
            this.quadraticCurveTo(x, y, x + r1, y);
            this.closePath();
            return this;
        };
    }

    const loop = (ts) => {
        if (!state.lastTs) state.lastTs = ts;
        const rawDt = (ts - state.lastTs) / 1000;
        state.lastTs = ts;
        const dt = clamp(rawDt, 0, 0.05);

        if (state.running && !state.paused) step(dt);
        draw(dt);
        requestAnimationFrame(loop);
    };

    const startOrResume = () => {
        if (!state.running) {
            reset();
            hideOverlay();
            canvas.focus?.();
            return;
        }
        if (state.paused) {
            state.paused = false;
            hideOverlay();
        }
    };

    // Input: keyboard
    window.addEventListener(
        'keydown',
        (e) => {
            if (e.key === ' ' || e.code === 'Space') {
                e.preventDefault();
                if (overlay && !overlay.hidden) {
                    startOrResume();
                } else {
                    togglePause();
                }
                return;
            }

            if (e.key === 'Enter' && overlay && !overlay.hidden) {
                startOrResume();
                return;
            }

            if (e.key === 'ArrowLeft') {
                // Switch to left side, keep vertical
                setSelected(state.selected === 2 ? 0 : state.selected === 3 ? 1 : state.selected);
            } else if (e.key === 'ArrowRight') {
                setSelected(state.selected === 0 ? 2 : state.selected === 1 ? 3 : state.selected);
            } else if (e.key === 'ArrowUp') {
                setSelected(state.selected === 1 ? 0 : state.selected === 3 ? 2 : state.selected);
            } else if (e.key === 'ArrowDown') {
                setSelected(state.selected === 0 ? 1 : state.selected === 2 ? 3 : state.selected);
            }
        },
        { passive: false },
    );

    // Input: click/tap on quadrants
    stage.addEventListener(
        'pointerdown',
        (e) => {
            const rect = canvas.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const y = e.clientY - rect.top;
            const left = x < rect.width / 2;
            const top = y < rect.height / 2;

            const pos = left ? (top ? 0 : 1) : top ? 2 : 3;
            setSelected(pos);

            if (overlay && !overlay.hidden && e.pointerType !== 'mouse') {
                // on touch, allow quick start
                startOrResume();
            }
        },
        { passive: true },
    );

    // Input: explicit corner buttons
    stage.querySelectorAll('[data-pos]').forEach((btn) => {
        btn.addEventListener(
            'click',
            (e) => {
                const pos = Number(e.currentTarget.getAttribute('data-pos'));
                if (!Number.isNaN(pos)) setSelected(pos);
                if (overlay && !overlay.hidden) startOrResume();
            },
            { passive: true },
        );
    });

    // Pause when tab is hidden
    document.addEventListener('visibilitychange', () => {
        if (document.hidden && state.running) {
            state.paused = true;
            showOverlay({
                title: 'Paused',
                message: 'You switched tabs. Press Space to resume.',
                buttonLabel: 'Resume',
            });
        }
    });

    // Overlay buttons
    if (btnStart) {
        btnStart.addEventListener('click', startOrResume, { passive: true });
    }
    if (btnFocus) {
        btnFocus.addEventListener(
            'click',
            () => {
                canvas.setAttribute('tabindex', '0');
                canvas.focus();
            },
            { passive: true },
        );
    }

    // Initial state
    canvas.setAttribute('tabindex', '0');
    setSelected(3);
    updateHud();
    showOverlay({
        title: 'TimeCatch',
        message: 'Catch the time tokens by rotating the clock hand to the correct corner.',
        buttonLabel: 'Start',
    });
    draw(0);
    requestAnimationFrame(loop);
})();


