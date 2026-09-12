// A performance HUD, off by default, shown with `?perf=1`.
//
// WHY IT EXISTS: the headless harness in tools/ can measure the CPU side of a frame
// exactly — WebGLRenderer.render() is synchronous JS — but it CANNOT measure the GPU
// side at all. swiftshader queues fragment work and returns from render() before any of
// it runs (the same reason CLAUDE.md's ReadPixels finding needed a Chrome trace), and it
// runs at devicePixelRatio 1 while a retina laptop runs at 2 with antialiasing, i.e. 4x
// the pixels. So "is this scene fill-bound?" is unanswerable from a container and has to
// be read on the real machine. That is what this panel is for.
//
// The instrument that actually settles it is EXT_disjoint_timer_query_webgl2: true GPU
// milliseconds per frame, which Chrome exposes on a real GPU. With CPU submission and GPU
// execution side by side, "cap the pixel ratio?" stops being a guess. `?dpr=<n>` overrides
// the pixel ratio so you can watch the GPU number move as you change it.
const fmt = (n, d = 1) => (n == null ? '—' : n.toFixed(d));

export function setupPerf({ world, scene, getExtra }) {
  const renderer = world.renderer.three;
  const el = document.createElement('div');
  el.style.cssText = [
    'position:fixed', 'right:8px', 'bottom:8px', 'z-index:9999',
    'font:11px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace',
    'background:rgba(16,20,28,0.86)', 'color:#d7e3f4', 'padding:8px 10px',
    'border-radius:6px', 'white-space:pre', 'pointer-events:none',
    'min-width:210px', 'box-shadow:0 2px 10px rgba(0,0,0,0.35)',
  ].join(';');
  const readout = document.createElement('div');
  readout.style.cssText = 'white-space:pre';
  const controls = document.createElement('div');
  // the panel itself stays click-through so it never eats a drag on the model;
  // only the buttons take the pointer
  controls.style.cssText = 'pointer-events:auto;display:flex;gap:5px;margin-top:7px;flex-wrap:wrap';
  const mkBtn = (label, fn) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.style.cssText = 'font:600 10px ui-monospace,Menlo,monospace;background:#2c3a4e;color:#d7e3f4;' +
      'border:1px solid #46586f;border-radius:5px;padding:3px 7px;cursor:pointer';
    b.addEventListener('click', () => fn(b));
    controls.appendChild(b);
    return b;
  };
  const verdict = document.createElement('div');
  verdict.style.cssText = 'white-space:pre;margin-top:6px;color:#9fd3a0';
  el.append(readout, controls, verdict);
  document.body.appendChild(el);

  // --- real GPU time, if this machine can give it ------------------------
  // One query in flight at a time: a timer query's result is not ready until some
  // frames later, so polling the one we issued and only issuing a new one when the
  // last has landed keeps this to a single object and no stalls.
  const gl = renderer.getContext();
  const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  let query = null, gpuMs = null;
  const gpuBegin = () => {
    if (!ext || query) return;
    query = gl.createQuery();
    gl.beginQuery(ext.TIME_ELAPSED_EXT, query);
  };
  const gpuEnd = () => {
    if (!ext || !query) return;
    gl.endQuery(ext.TIME_ELAPSED_EXT);
    const q = query;
    // poll next frame(s); drop the result if the GPU was disjoint (clock changed)
    const poll = () => {
      if (gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) {
        if (!gl.getParameter(ext.GPU_DISJOINT_EXT)) gpuMs = gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6;
        gl.deleteQuery(q);
        query = null;
      } else requestAnimationFrame(poll);
    };
    requestAnimationFrame(poll);
  };

  // --- time render() itself: CPU submission, the half we CAN measure headless
  const origRender = renderer.render.bind(renderer);
  let cpuMs = 0, renders = 0;
  const total = { renders: 0, cpuMs: 0 };   // monotonic; the benchmark deltas these
  renderer.render = (...a) => {
    gpuBegin();
    const t = performance.now();
    origRender(...a);
    const dt = performance.now() - t;
    cpuMs += dt; renders++;
    total.renders++; total.cpuMs += dt;
    gpuEnd();
  };

  // Counting the scene graph every frame would itself be a bottleneck; once a
  // second is plenty for a number that only moves when a level lands.
  let meshes = 0, hidden = 0, lightsOn = 0, lightsAll = 0, counted = 0;
  const census = () => {
    meshes = hidden = lightsOn = lightsAll = 0;
    scene.traverse((o) => {
      // ON and TOTAL, because the gap between them is the whole question: a fixture
      // switched off sets light.visible = false and drops out of the shader, so the
      // exhibits' lights are only free when their scene is off.
      if (o.isLight) { lightsAll++; if (o.visible) lightsOn++; }
      if (!o.isMesh) return;
      o.visible ? meshes++ : hidden++;
    });
    counted = performance.now();
  };
  census();

  // Report frames DRAWN, not animation-frame ticks. The viewer renders on demand, so
  // the tick loop keeps running at 60 Hz while the renderer draws twice a second —
  // counting ticks would report a confident 60 fps over a picture that is not moving.
  let last = performance.now();
  const tick = () => {
    const now = performance.now();
    if (now - last >= 1000) {
      const secs = (now - last) / 1000;
      if (now - counted > 5000) census();
      const x = (getExtra && getExtra()) || {};
      const info = renderer.info;
      readout.textContent =
        `${fmt(renders / secs, 0)} fps drawn  (on demand)\n` +
        `render()   ${fmt(renders ? cpuMs / renders : 0)} ms cpu\n` +
        `gpu        ${ext ? fmt(gpuMs) + ' ms' : 'n/a (no timer ext)'}\n` +
        `draw calls ${info.render.calls}\n` +
        `triangles  ${(info.render.triangles / 1000).toFixed(0)}k\n` +
        `programs   ${info.programs ? info.programs.length : '—'}\n` +
        `meshes     ${meshes} drawn / ${hidden} hidden\n` +
        `lights     ${lightsOn} on / ${lightsAll} total\n` +
        `pixels     ${renderer.domElement.width}x${renderer.domElement.height} @dpr ${renderer.getPixelRatio()}\n` +
        (x.merged != null ? `merged     ${x.merged} from ${x.absorbed}\n` : '') +
        (x.note ? `${x.note}\n` : '');
      cpuMs = 0; renders = 0; last = now;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  // --- BENCHMARK ---------------------------------------------------------
  // An idle "2 fps drawn" is correct and tells you nothing. Achieved frame rate under
  // CONTINUOUS rendering includes GPU time by definition, and on a browser with no
  // timer query (Safari exposes none) it is the only way to see the GPU at all. So:
  // force AUTO, spin the camera for a few seconds, count what actually got drawn, and
  // put the mode back exactly as it was — leaving it in AUTO would silently undo
  // render-on-demand.
  let running = false;
  const benchmark = async (btn, seconds = 3) => {
    if (running) return null;
    running = true;
    const label = btn && btn.textContent;
    if (btn) { btn.textContent = 'measuring…'; btn.disabled = true; }
    const prevMode = world.renderer.mode;
    const c = world.camera.controls;
    const r0 = total.renders, c0 = total.cpuMs, t0 = performance.now();
    try {
      world.renderer.mode = 1;                       // AUTO: draw flat out
      const until = t0 + seconds * 1000;
      while (performance.now() < until) {
        c.rotate(0.004, 0, false);                   // a real load, not an empty loop
        await new Promise((res) => requestAnimationFrame(res));
      }
    } finally {
      world.renderer.mode = prevMode;                // ALWAYS, even if the spin threw
      world.renderer.needsUpdate = true;
      running = false;
      if (btn) { btn.textContent = label; btn.disabled = false; }
    }
    const secs = (performance.now() - t0) / 1000;
    const drew = total.renders - r0;
    const cpu = drew ? (total.cpuMs - c0) / drew : 0;
    const frame = drew ? (secs * 1000) / drew : 0;
    const res = { fps: drew / secs, frameMs: frame, cpuMs: cpu, other: Math.max(0, frame - cpu),
                  frames: drew, dpr: renderer.getPixelRatio(), lightsOn };
    verdict.textContent =
      `${res.fps.toFixed(1)} fps flat out  (${drew} frames)\n` +
      `  ${res.frameMs.toFixed(1)} ms/frame = ${res.cpuMs.toFixed(1)} cpu + ${res.other.toFixed(1)} other\n` +
      `  at dpr ${res.dpr}, ${lightsOn} lights on`;
    last = performance.now(); cpuMs = 0; renders = 0;   // don't let the burst skew the 1 s line
    return res;
  };

  // --- LIGHTS CONTROL ----------------------------------------------------
  // Every fragment loops over every VISIBLE light, so with the exhibits loaded and lit
  // the ground floor pays for the Second Floor's and the Attic's fixtures too. This
  // switches off everything that is not on the level you are looking at, purely so the
  // two benchmarks can be compared. It writes the lights directly and restores from a
  // snapshot rather than going through setFixtures, so it cannot disturb that
  // bookkeeping — and it is a measurement control, not a default.
  let dimmed = null;
  const dimOtherLevels = (btn) => {
    const fixtures = (window.__eureka && window.__eureka.fixtures) || [];
    if (dimmed) {
      for (const { f, vis, int, em } of dimmed) {
        f.light.visible = vis; f.light.intensity = int;
        if (f.emiss && em != null) f.emiss.emissiveIntensity = em;
      }
      dimmed = null;
    } else {
      const keep = (window.__eureka.activeLevel && window.__eureka.activeLevel()) || 'ground';
      dimmed = [];
      for (const f of fixtures) {
        if (f.level === keep) continue;
        dimmed.push({ f, vis: f.light.visible, int: f.light.intensity,
                      em: f.emiss ? f.emiss.emissiveIntensity : null });
        f.light.visible = false; f.light.intensity = 0;
        if (f.emiss) f.emiss.emissiveIntensity = 0;
      }
    }
    census();
    if (btn) btn.textContent = dimmed ? `all levels lit` : `dim other levels`;
    world.renderer.needsUpdate = true;
    return { dimmed: !!dimmed, lightsOn };
  };

  const benchBtn = mkBtn('benchmark 3s', (b) => benchmark(b));
  const dimBtn = mkBtn('dim other levels', (b) => dimOtherLevels(b));

  return {
    el,
    hasGpuTimer: !!ext,
    benchmark: (secs) => benchmark(benchBtn, secs),
    dimOtherLevels: () => dimOtherLevels(dimBtn),
    mode: () => world.renderer.mode,
    lightsOn: () => lightsOn,
    visible: () => el.style.display !== 'none',
    setVisible: (on) => { el.style.display = on ? '' : 'none'; },
  };
}

// `?dpr=<n>` — override the pixel ratio to see what fill rate actually costs.
// That Open's SimpleRenderer sets min(devicePixelRatio, 2) with antialias on, so a
// retina display draws 4x the pixels with MSAA; whether that matters here is exactly
// the question no headless run can answer.
export function applyDprOverride(world) {
  const want = new URLSearchParams(location.search).get('dpr');
  if (!want) return null;
  const n = Number(want);
  if (!(n > 0 && n <= 4)) return null;
  const r = world.renderer.three;
  r.setPixelRatio(n);
  const c = r.domElement;
  r.setSize(c.clientWidth, c.clientHeight, false);
  return n;
}
