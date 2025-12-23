(() => {
    const stage = document.getElementById('game-stage');
    const canvas = document.getElementById('game-canvas');
    const overlay = document.getElementById('game-overlay');
    const overlayTitle = document.getElementById('overlay-title');
    const overlayMessage = document.getElementById('overlay-message');
    const btnStart = document.getElementById('btn-start');
    const btnFocus = document.getElementById('btn-focus');

    const budgetEl = document.getElementById('stat-budget');
    const deadlineEl = document.getElementById('stat-deadline');
    const hitsEl = document.getElementById('stat-hits');
    const clockEl = document.getElementById('stat-clock');

    if (!stage || !canvas) return;

    // Prefer reduced motion
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

    const showOverlay = ({ title, message, buttonLabel }) => {
        if (overlayTitle) overlayTitle.textContent = title;
        if (overlayMessage) overlayMessage.textContent = message;
        if (btnStart) btnStart.textContent = buttonLabel;
        if (overlay) overlay.hidden = false;
    };

    const hideOverlay = () => {
        if (overlay) overlay.hidden = true;
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

    // Three.js / WebGL guards
    const webglAvailable = () => {
        try {
            const testCanvas = document.createElement('canvas');
            const gl = testCanvas.getContext('webgl') || testCanvas.getContext('experimental-webgl');
            return !!gl && typeof WebGLRenderingContext !== 'undefined';
        } catch (_) {
            return false;
        }
    };

    if (!window.THREE || !webglAvailable()) {
        showOverlay({
            title: '3D unavailable',
            message: 'Your browser has WebGL disabled, so the 3D game cannot start.',
            buttonLabel: 'OK',
        });
        if (btnStart) btnStart.disabled = true;
        return;
    }

    const THREE = window.THREE;

    const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
    const lerp = (a, b, t) => a + (b - a) * t;
    const rand = (min, max) => min + Math.random() * (max - min);

    // Game constants
    const START_BUDGET = 30; // seconds
    const BUDGET_DRAIN_PER_SEC = 1.0;
    const CLOCK_PICKUP_BONUS = 6; // seconds
    const HIT_PENALTY = 8; // seconds
    const GOAL_DISTANCE = 900; // arbitrary units to reach "Project Deadline"

    // Lanes (4 corners inside tunnel)
    const laneR = 1.55;
    const lanes = [
        { x: -laneR, y: laneR }, // TL
        { x: -laneR, y: -laneR }, // BL
        { x: laneR, y: laneR }, // TR
        { x: laneR, y: -laneR }, // BR
    ];

    const state = {
        running: false,
        paused: false,
        budget: START_BUDGET,
        hits: 0,
        distance: 0,
        speed: 22, // units/sec (world objects move toward camera)
        speedTarget: 22,
        lane: 3,
        laneTarget: 3,
        lastTs: 0,
        spawnObstacleT: 0.9,
        spawnPickupT: 0.8,
        objects: [],
        pickups: [],
        effects: [],
        cameraShake: 0,
    };

    const hud = () => {
        if (budgetEl) budgetEl.textContent = `${Math.max(0, Math.ceil(state.budget))}s`;
        if (hitsEl) hitsEl.textContent = String(state.hits);
        if (deadlineEl) {
            const pct = clamp((state.distance / GOAL_DISTANCE) * 100, 0, 100);
            deadlineEl.textContent = `${Math.floor(pct)}%`;
        }
    };
    hud();

    // ---- Scene setup ----
    const scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0x0b1220, 0.035);

    const camera = new THREE.PerspectiveCamera(58, 1, 0.1, 240);
    camera.position.set(0, 0.35, 6.4);
    camera.lookAt(0, 0, -18);

    const renderer = new THREE.WebGLRenderer({
        canvas,
        antialias: true,
        alpha: true,
        powerPreference: 'high-performance',
    });
    renderer.setClearColor(0x000000, 0);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;

    // Lights (dynamic)
    scene.add(new THREE.AmbientLight(0xffffff, 0.55));
    const key = new THREE.DirectionalLight(0xffffff, 0.75);
    key.position.set(2.2, 3.5, 5.5);
    scene.add(key);
    const runLight = new THREE.PointLight(0x55b761, 1.1, 30, 2.0);
    runLight.position.set(0, 0, 1.5);
    scene.add(runLight);

    const pulseLight = new THREE.PointLight(0x55b761, 0.7, 45, 2.0);
    pulseLight.position.set(0, 0, -28);
    scene.add(pulseLight);

    // Tunnel texture (procedural)
    const makeTunnelTexture = () => {
        const c = document.createElement('canvas');
        c.width = 256;
        c.height = 256;
        const g = c.getContext('2d');
        if (!g) return null;

        g.clearRect(0, 0, 256, 256);
        g.fillStyle = '#0b1220';
        g.fillRect(0, 0, 256, 256);

        // Rings
        for (let y = 0; y < 256; y += 32) {
            g.globalAlpha = 0.35;
            g.fillStyle = '#55b761';
            g.fillRect(0, y, 256, 1);
            g.globalAlpha = 0.12;
            g.fillStyle = '#ffffff';
            g.fillRect(0, y + 2, 256, 1);
        }

        // Subtle diagonal "time streaks"
        g.globalAlpha = 0.16;
        g.strokeStyle = '#ffffff';
        g.lineWidth = 2;
        for (let i = -256; i < 256; i += 42) {
            g.beginPath();
            g.moveTo(i, 256);
            g.lineTo(i + 256, 0);
            g.stroke();
        }
        g.globalAlpha = 1;

        const tex = new THREE.CanvasTexture(c);
        tex.wrapS = THREE.RepeatWrapping;
        tex.wrapT = THREE.RepeatWrapping;
        tex.repeat.set(6, 24);
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = 8;
        return tex;
    };

    const tunnelTex = makeTunnelTexture();
    const tunnelMat = new THREE.MeshStandardMaterial({
        color: 0x0b1220,
        map: tunnelTex || null,
        emissive: new THREE.Color('#55b761'),
        emissiveIntensity: 0.35,
        roughness: 0.85,
        metalness: 0.1,
        side: THREE.BackSide,
    });

    const tunnelGeo = new THREE.CylinderGeometry(5.6, 5.6, 140, 48, 64, true);
    tunnelGeo.rotateX(Math.PI / 2);
    const tunnel = new THREE.Mesh(tunnelGeo, tunnelMat);
    tunnel.position.z = -52;
    scene.add(tunnel);

    // Particles for speed
    const makeParticles = () => {
        const count = 850;
        const positions = new Float32Array(count * 3);
        for (let i = 0; i < count; i++) {
            const a = Math.random() * Math.PI * 2;
            const r = rand(0.4, 5.0);
            positions[i * 3 + 0] = Math.cos(a) * r;
            positions[i * 3 + 1] = Math.sin(a) * r;
            positions[i * 3 + 2] = rand(-120, 8);
        }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        const mat = new THREE.PointsMaterial({
            size: 0.035,
            color: 0xffffff,
            transparent: true,
            opacity: 0.55,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
        });
        const pts = new THREE.Points(geo, mat);
        pts.userData = { positions, count };
        return pts;
    };
    const particles = makeParticles();
    particles.position.z = 0;
    scene.add(particles);

    // Focus sphere
    const sphereGeo = new THREE.SphereGeometry(0.33, 32, 32);
    const sphereMat = new THREE.MeshPhysicalMaterial({
        color: 0x55b761,
        roughness: 0.18,
        metalness: 0.05,
        clearcoat: 0.9,
        clearcoatRoughness: 0.2,
        emissive: new THREE.Color('#0b3d1b'),
        emissiveIntensity: 0.22,
    });
    const focusSphere = new THREE.Mesh(sphereGeo, sphereMat);
    focusSphere.position.set(lanes[state.lane].x, lanes[state.lane].y, 0.9);
    scene.add(focusSphere);

    const focusGlow = new THREE.PointLight(0x55b761, 0.85, 8, 2.0);
    focusGlow.position.set(0, 0, 0.9);
    scene.add(focusGlow);

    // Icon textures (procedural) - we avoid trademarked logos; these are generic "distraction" symbols.
    const makeIconTexture = (type) => {
        const c = document.createElement('canvas');
        c.width = 256;
        c.height = 256;
        const g = c.getContext('2d');
        if (!g) return null;

        g.clearRect(0, 0, 256, 256);

        // background glow
        const bg = g.createRadialGradient(128, 96, 18, 128, 128, 130);
        bg.addColorStop(0, 'rgba(255,255,255,0.25)');
        bg.addColorStop(1, 'rgba(255,255,255,0.0)');
        g.fillStyle = bg;
        g.beginPath();
        g.arc(128, 128, 120, 0, Math.PI * 2);
        g.fill();

        const drawBadge = (accent) => {
            g.fillStyle = 'rgba(15, 23, 42, 0.65)';
            g.strokeStyle = 'rgba(255,255,255,0.25)';
            g.lineWidth = 6;
            g.beginPath();
            g.arc(128, 128, 96, 0, Math.PI * 2);
            g.fill();
            g.stroke();

            g.strokeStyle = accent;
            g.globalAlpha = 0.85;
            g.lineWidth = 6;
            g.beginPath();
            g.arc(128, 128, 78, 0, Math.PI * 2);
            g.stroke();
            g.globalAlpha = 1;
        };

        if (type === 'clock') {
            drawBadge('rgba(85,183,97,0.95)');
            g.strokeStyle = 'rgba(255,255,255,0.92)';
            g.lineWidth = 8;
            g.beginPath();
            g.arc(128, 128, 58, 0, Math.PI * 2);
            g.stroke();

            // hands
            g.lineCap = 'round';
            g.strokeStyle = 'rgba(85,183,97,0.95)';
            g.lineWidth = 10;
            g.beginPath();
            g.moveTo(128, 128);
            g.lineTo(128, 92);
            g.stroke();
            g.strokeStyle = 'rgba(255,255,255,0.85)';
            g.lineWidth = 7;
            g.beginPath();
            g.moveTo(128, 128);
            g.lineTo(162, 132);
            g.stroke();
        } else if (type === 'social') {
            drawBadge('rgba(147,197,253,0.95)');
            // chat bubbles
            g.fillStyle = 'rgba(255,255,255,0.92)';
            g.beginPath();
            g.roundRect(62, 86, 132, 70, 18);
            g.fill();
            g.beginPath();
            g.moveTo(98, 156);
            g.lineTo(86, 178);
            g.lineTo(122, 156);
            g.closePath();
            g.fill();
            g.fillStyle = 'rgba(15,23,42,0.65)';
            g.roundRect(88, 108, 84, 10, 5);
            g.roundRect(88, 128, 56, 10, 5);
            g.fill();
        } else if (type === 'email') {
            drawBadge('rgba(253,224,71,0.95)');
            // envelope
            g.fillStyle = 'rgba(255,255,255,0.92)';
            g.roundRect(66, 92, 124, 88, 14);
            g.fill();
            g.strokeStyle = 'rgba(15,23,42,0.55)';
            g.lineWidth = 6;
            g.beginPath();
            g.moveTo(72, 102);
            g.lineTo(128, 146);
            g.lineTo(184, 102);
            g.stroke();
        } else if (type === 'meeting') {
            drawBadge('rgba(251,113,133,0.95)');
            // calendar
            g.fillStyle = 'rgba(255,255,255,0.92)';
            g.roundRect(74, 86, 108, 100, 16);
            g.fill();
            g.fillStyle = 'rgba(15,23,42,0.62)';
            g.roundRect(88, 112, 80, 12, 6);
            g.roundRect(88, 136, 64, 12, 6);
            g.roundRect(88, 160, 52, 12, 6);
            g.fill();
            g.fillStyle = 'rgba(251,113,133,0.95)';
            g.roundRect(74, 86, 108, 20, 12);
            g.fill();
        }

        const tex = new THREE.CanvasTexture(c);
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = 8;
        return tex;
    };

    // roundRect polyfill for older browsers (for icon drawing only)
    if (CanvasRenderingContext2D && !CanvasRenderingContext2D.prototype.roundRect) {
        // eslint-disable-next-line no-extend-native
        CanvasRenderingContext2D.prototype.roundRect = function (x, y, w, h, r) {
            const rr = Array.isArray(r) ? r : [r, r, r, r];
            const r1 = rr[0] || 0;
            const r2 = rr[1] || r1;
            const r3 = rr[2] || r1;
            const r4 = rr[3] || r2;
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

    const texClock = makeIconTexture('clock');
    const texSocial = makeIconTexture('social');
    const texEmail = makeIconTexture('email');
    const texMeeting = makeIconTexture('meeting');

    const spriteMat = (tex, tint = 0xffffff) =>
        new THREE.SpriteMaterial({
            map: tex || null,
            color: tint,
            transparent: true,
            depthWrite: false,
        });

    const obstacleMats = [spriteMat(texSocial), spriteMat(texEmail), spriteMat(texMeeting)];
    const pickupMat = spriteMat(texClock, 0xffffff);

    const spawnSprite = ({ lane, z, mat, scale, kind }) => {
        const sp = new THREE.Sprite(mat);
        sp.position.set(lanes[lane].x, lanes[lane].y, z);
        sp.scale.setScalar(scale);
        sp.userData = { lane, z, kind, hit: false };
        scene.add(sp);
        return sp;
    };

    const spawnObstacle = () => {
        state.spawnObstacleT = rand(0.55, 1.05) / (1 + state.distance / GOAL_DISTANCE);
        const lane = Math.floor(Math.random() * 4);
        const kind = ['social', 'email', 'meeting'][Math.floor(Math.random() * 3)];
        const mat = obstacleMats[kind === 'social' ? 0 : kind === 'email' ? 1 : 2];
        const scale = 1.15;
        const sp = spawnSprite({ lane, z: -92, mat, scale, kind });
        state.objects.push(sp);
    };

    const spawnPickup = () => {
        state.spawnPickupT = rand(0.65, 1.35);
        const lane = Math.floor(Math.random() * 4);
        const sp = spawnSprite({ lane, z: -85, mat: pickupMat, scale: 1.0, kind: 'clock' });
        state.pickups.push(sp);
    };

    // Deadline gate
    const gateGroup = new THREE.Group();
    const gateMat = new THREE.MeshStandardMaterial({
        color: 0xffffff,
        roughness: 0.35,
        metalness: 0.2,
        emissive: new THREE.Color('#ff3b5c'),
        emissiveIntensity: 0.35,
        transparent: true,
        opacity: 0.9,
    });
    const gateGeo = new THREE.TorusGeometry(3.7, 0.12, 18, 96);
    const gate = new THREE.Mesh(gateGeo, gateMat);
    gate.rotation.x = Math.PI / 2;
    gate.position.set(0, 0, -120);
    gateGroup.add(gate);
    gateGroup.visible = false;
    scene.add(gateGroup);

    const playShake = (amount = 1) => {
        stage.classList.remove('shake');
        void stage.offsetWidth;
        stage.classList.add('shake');
        state.cameraShake = Math.max(state.cameraShake, amount);
    };

    const reset = () => {
        state.running = true;
        state.paused = false;
        state.budget = START_BUDGET;
        state.hits = 0;
        state.distance = 0;
        state.speed = 22;
        state.speedTarget = 22;
        state.lane = 3;
        state.laneTarget = 3;
        state.spawnObstacleT = 0.7;
        state.spawnPickupT = 0.7;
        state.cameraShake = 0;

        // cleanup
        for (const o of state.objects) scene.remove(o);
        for (const p of state.pickups) scene.remove(p);
        state.objects = [];
        state.pickups = [];

        focusSphere.position.set(lanes[state.lane].x, lanes[state.lane].y, 0.9);
        focusGlow.position.copy(focusSphere.position);
        gateGroup.visible = false;
        hud();
    };

    const win = () => {
        state.running = false;
        state.paused = false;
        showOverlay({
            title: 'Deadline reached',
            message: `Nice — you made it to the Project Deadline with ${Math.ceil(state.budget)}s left.`,
            buttonLabel: 'Play again',
        });
    };

    const lose = () => {
        state.running = false;
        state.paused = false;
        showOverlay({
            title: 'Out of budget',
            message: 'Distractions stole your time. Collect clocks and try again.',
            buttonLabel: 'Play again',
        });
    };

    const togglePause = () => {
        if (!state.running) return;
        state.paused = !state.paused;
        if (state.paused) {
            showOverlay({ title: 'Paused', message: 'Press Space to resume.', buttonLabel: 'Resume' });
        } else {
            hideOverlay();
        }
    };

    const setLane = (lane) => {
        state.laneTarget = clamp(lane | 0, 0, 3);
    };

    // Resize handling
    const resize = () => {
        const rect = stage.getBoundingClientRect();
        const w = Math.max(1, Math.floor(rect.width));
        const h = Math.max(1, Math.floor(rect.height));
        renderer.setSize(w, h, false);
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(stage);
    window.addEventListener('resize', resize, { passive: true });
    resize();

    // Input
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
                setLane(state.laneTarget === 2 ? 0 : state.laneTarget === 3 ? 1 : state.laneTarget);
            } else if (e.key === 'ArrowRight') {
                setLane(state.laneTarget === 0 ? 2 : state.laneTarget === 1 ? 3 : state.laneTarget);
            } else if (e.key === 'ArrowUp') {
                setLane(state.laneTarget === 1 ? 0 : state.laneTarget === 3 ? 2 : state.laneTarget);
            } else if (e.key === 'ArrowDown') {
                setLane(state.laneTarget === 0 ? 1 : state.laneTarget === 2 ? 3 : state.laneTarget);
            }
        },
        { passive: false },
    );

    stage.addEventListener(
        'pointerdown',
        (e) => {
            const rect = canvas.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const y = e.clientY - rect.top;
            const left = x < rect.width / 2;
            const top = y < rect.height / 2;
            const lane = left ? (top ? 0 : 1) : top ? 2 : 3;
            setLane(lane);
            if (overlay && !overlay.hidden && e.pointerType !== 'mouse') startOrResume();
        },
        { passive: true },
    );

    stage.querySelectorAll('[data-pos]').forEach((btn) => {
        btn.addEventListener(
            'click',
            (e) => {
                const lane = Number(e.currentTarget.getAttribute('data-pos'));
                if (!Number.isNaN(lane)) setLane(lane);
                if (overlay && !overlay.hidden) startOrResume();
            },
            { passive: true },
        );
    });

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

    if (btnStart) btnStart.addEventListener('click', startOrResume, { passive: true });
    if (btnFocus)
        btnFocus.addEventListener(
            'click',
            () => {
                canvas.setAttribute('tabindex', '0');
                canvas.focus();
            },
            { passive: true },
        );

    // ---- Game loop ----
    const step = (dt) => {
        // speed ramps with progress (but keep tasteful)
        const progressPct = clamp(state.distance / GOAL_DISTANCE, 0, 1);
        state.speedTarget = 22 + progressPct * 18;
        state.speed = lerp(state.speed, state.speedTarget, 0.04);

        // budget drains as time passes
        state.budget -= dt * BUDGET_DRAIN_PER_SEC;

        // progress
        state.distance += dt * state.speed;

        // show gate near the end
        if (state.distance > GOAL_DISTANCE * 0.82) {
            gateGroup.visible = true;
            gate.position.z = -32 - (GOAL_DISTANCE - state.distance) * 0.05;
            gate.material.opacity = 0.6 + 0.35 * Math.sin(state.distance * 0.02);
        }

        if (state.distance >= GOAL_DISTANCE) {
            win();
            return;
        }

        if (state.budget <= 0) {
            state.budget = 0;
            lose();
            return;
        }

        // spawn timers
        state.spawnObstacleT -= dt;
        if (state.spawnObstacleT <= 0) spawnObstacle();
        state.spawnPickupT -= dt;
        if (state.spawnPickupT <= 0) spawnPickup();

        // lane movement (smooth)
        state.lane = state.laneTarget;
        const target = lanes[state.laneTarget];
        focusSphere.position.x = lerp(focusSphere.position.x, target.x, 0.16);
        focusSphere.position.y = lerp(focusSphere.position.y, target.y, 0.16);
        focusGlow.position.copy(focusSphere.position);

        // slight lean with motion
        const tiltX = (target.y - focusSphere.position.y) * 0.2;
        const tiltY = (focusSphere.position.x - target.x) * 0.2;
        focusSphere.rotation.x = lerp(focusSphere.rotation.x, tiltX, 0.12);
        focusSphere.rotation.y = lerp(focusSphere.rotation.y, tiltY, 0.12);
        focusSphere.rotation.z += dt * 1.8;

        // move tunnel texture for speed illusion
        if (tunnelTex && !reducedMotion) {
            tunnelTex.offset.y -= dt * (state.speed * 0.022);
        }

        // pulse light + run light wobble
        const pulse = reducedMotion ? 0 : Math.sin(state.distance * 0.05) * 0.35;
        pulseLight.intensity = 0.55 + pulse;
        pulseLight.position.z = -28 - (reducedMotion ? 0 : Math.sin(state.distance * 0.02) * 4);
        runLight.intensity = 0.95 + (reducedMotion ? 0 : Math.sin(state.distance * 0.08) * 0.12);

        // Particles
        const attr = particles.geometry.getAttribute('position');
        const pos = attr.array;
        const dz = dt * state.speed * (reducedMotion ? 0.6 : 1.0);
        for (let i = 0; i < pos.length; i += 3) {
            pos[i + 2] += dz;
            if (pos[i + 2] > 10) {
                pos[i + 2] = rand(-120, -60);
                const a = Math.random() * Math.PI * 2;
                const r = rand(0.8, 5.2);
                pos[i + 0] = Math.cos(a) * r;
                pos[i + 1] = Math.sin(a) * r;
            }
        }
        attr.needsUpdate = true;

        // Move sprites toward player and handle collision
        const hitZ = 1.1;
        const despawnZ = 6.5;

        for (let i = state.pickups.length - 1; i >= 0; i--) {
            const p = state.pickups[i];
            p.position.z += dt * state.speed;
            p.material.rotation += dt * 1.3;
            p.scale.setScalar(1.0 + (reducedMotion ? 0 : Math.sin((state.distance + i) * 0.04) * 0.05));
            if (!p.userData.hit && p.position.z >= hitZ && p.userData.lane === state.laneTarget) {
                p.userData.hit = true;
                state.budget = Math.min(99, state.budget + CLOCK_PICKUP_BONUS);
                playShake(0.3);
                hud();
                scene.remove(p);
                state.pickups.splice(i, 1);
                continue;
            }
            if (p.position.z >= despawnZ) {
                scene.remove(p);
                state.pickups.splice(i, 1);
            }
        }

        for (let i = state.objects.length - 1; i >= 0; i--) {
            const o = state.objects[i];
            o.position.z += dt * state.speed;
            o.material.rotation -= dt * 0.9;
            o.scale.setScalar(1.15 + (reducedMotion ? 0 : Math.sin((state.distance + i) * 0.05) * 0.07));
            if (!o.userData.hit && o.position.z >= hitZ && o.userData.lane === state.laneTarget) {
                o.userData.hit = true;
                state.hits += 1;
                state.budget -= HIT_PENALTY;
                playShake(1.0);
                hud();
                scene.remove(o);
                state.objects.splice(i, 1);
                continue;
            }
            if (o.position.z >= despawnZ) {
                scene.remove(o);
                state.objects.splice(i, 1);
            }
        }

        hud();
    };

    const render = (dt) => {
        // Camera subtle movement
        const baseZ = 6.4;
        const shake = Math.max(0, state.cameraShake);
        state.cameraShake = Math.max(0, state.cameraShake - dt * 2.6);

        const wob = reducedMotion ? 0 : Math.sin(state.distance * 0.02) * 0.06;
        camera.position.x = lerp(camera.position.x, focusSphere.position.x * 0.08, 0.06) + rand(-0.02, 0.02) * shake;
        camera.position.y = lerp(camera.position.y, 0.35 + focusSphere.position.y * 0.08 + wob, 0.06) + rand(-0.02, 0.02) * shake;
        camera.position.z = lerp(camera.position.z, baseZ, 0.06);
        camera.lookAt(0, 0, -18);

        renderer.render(scene, camera);
    };

    const loop = (ts) => {
        if (!state.lastTs) state.lastTs = ts;
        const rawDt = (ts - state.lastTs) / 1000;
        state.lastTs = ts;
        const dt = clamp(rawDt, 0, 0.05);

        if (state.running && !state.paused) step(dt);
        render(dt);
        requestAnimationFrame(loop);
    };

    // Initial overlay
    canvas.setAttribute('tabindex', '0');
    showOverlay({
        title: 'Focus Sphere: Distraction Dodger',
        message: 'Run the time tunnel. Collect clocks to refill your Time Budget. Avoid distractions.',
        buttonLabel: 'Start',
    });
    requestAnimationFrame(loop);
})();


