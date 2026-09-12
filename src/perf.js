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
  renderer.render = (...a) => {
    gpuBegin();
    const t = performance.now();
    origRender(...a);
    cpuMs += performance.now() - t;
    renders++;
    gpuEnd();
  };

  // Counting the scene graph every frame would itself be a bottleneck; once a
  // second is plenty for a number that only moves when a level lands.
  let meshes = 0, hidden = 0, lights = 0, counted = 0;
  const census = () => {
    meshes = hidden = lights = 0;
    scene.traverse((o) => {
      if (o.isLight && o.visible) lights++;
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
      el.textContent =
        `${fmt(renders / secs, 0)} fps drawn  (on demand)\n` +
        `render()   ${fmt(renders ? cpuMs / renders : 0)} ms cpu\n` +
        `gpu        ${ext ? fmt(gpuMs) + ' ms' : 'n/a (no timer ext)'}\n` +
        `draw calls ${info.render.calls}\n` +
        `triangles  ${(info.render.triangles / 1000).toFixed(0)}k\n` +
        `programs   ${info.programs ? info.programs.length : '—'}\n` +
        `meshes     ${meshes} drawn / ${hidden} hidden\n` +
        `lights     ${lights}\n` +
        `pixels     ${renderer.domElement.width}x${renderer.domElement.height} @dpr ${renderer.getPixelRatio()}\n` +
        (x.merged != null ? `merged     ${x.merged} from ${x.absorbed}\n` : '') +
        (x.note ? `${x.note}\n` : '');
      cpuMs = 0; renders = 0; last = now;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  return {
    el,
    hasGpuTimer: !!ext,
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
