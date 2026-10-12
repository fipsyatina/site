(() => {
  'use strict';

  const container = document.getElementById('orb');
  const canvas = document.getElementById('orb-canvas');

  if (!container || !canvas) {
    if (container) container.dataset.renderer = 'fallback';
    return;
  }

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const finePointer = window.matchMedia('(hover: hover) and (pointer: fine)');
  const saveData = Boolean(navigator.connection && navigator.connection.saveData);
  const scrollRoot = document.getElementById('scroll-container');
  const pointerSurface = document.getElementById('section1') || window;
  const LOOP_DURATION = 24;
  const STILL_PHASE = 0;
  const referenceImage = new Image();
  referenceImage.decoding = 'async';
  container.dataset.loopDuration = String(LOOP_DURATION);

  let gl = null;
  let program = null;
  let vertexBuffer = null;
  let referenceTexture = null;
  let uniforms = null;
  let animationFrame = 0;
  let resizeFrame = 0;
  let observer = null;
  let resizeObserver = null;
  let isIntersecting = true;
  let pageActive = true;
  let destroyed = false;
  let contextLost = false;
  let elapsed = 0;
  let lastFrameTime = 0;
  let pointerX = 0;
  let pointerY = 0;
  let targetPointerX = 0;
  let targetPointerY = 0;
  let pulse = 0;

  const vertexSource = `
    attribute vec2 a_position;

    void main() {
      gl_Position = vec4(a_position, 0.0, 1.0);
    }
  `;

  // The source frame preserves the video's exact material and studio lighting.
  // Only the sampling coordinates move; no video is loaded or played.
  const fragmentBody = `
    uniform vec2 u_resolution;
    uniform vec2 u_pointer;
    uniform float u_time;
    uniform float u_pulse;
    uniform sampler2D u_reference;

    void main() {
      vec2 p = (gl_FragCoord.xy - 0.5 * u_resolution) / min(u_resolution.x, u_resolution.y);
      p *= 1.25;
      float phase = u_time;
      // Periodic flow returns to the untouched reference at phase zero.
      vec2 flow = vec2(
        sin(p.y * 5.0 + p.x * 2.0) * sin(phase),
        sin(p.x * 4.0 - p.y * 3.0) * sin(phase * 2.0)
      );
      p += flow * 0.027;
      p += vec2(sin(phase), sin(phase * 2.0)) * 0.009;
      float radius = length(p);
      p *= 1.0 + 0.022 * sin(phase) + u_pulse * 0.025 * sin(radius * 18.0 - phase * 4.0);
      p += u_pointer * (0.014 + radius * radius * 0.025);
      vec2 sampleUv = p + 0.5;
      if (sampleUv.x < 0.0 || sampleUv.x > 1.0 || sampleUv.y < 0.0 || sampleUv.y > 1.0) {
        gl_FragColor = vec4(0.0);
        return;
      }
      vec3 color = texture2D(u_reference, sampleUv).rgb;
      gl_FragColor = vec4(color, 1.0);
    }
  `;

  function setRenderer(value) {
    container.dataset.renderer = value;
  }

  function compileShader(type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const message = gl.getShaderInfoLog(shader) || 'Unknown shader compilation error';
      gl.deleteShader(shader);
      throw new Error(message);
    }
    return shader;
  }

  function releaseGraphics() {
    if (!gl || contextLost) return;
    if (referenceTexture) gl.deleteTexture(referenceTexture);
    referenceTexture = null;
    if (vertexBuffer) gl.deleteBuffer(vertexBuffer);
    if (program) gl.deleteProgram(program);
    vertexBuffer = null;
    program = null;
    uniforms = null;
  }

  function createGraphics() {
    contextLost = false;
    gl = canvas.getContext('webgl', {
      alpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: true,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: false
    });

    if (!gl) throw new Error('WebGL is unavailable');

    const highp = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT);
    const precision = highp && highp.precision > 0 ? 'highp' : 'mediump';
    const vertexShader = compileShader(gl.VERTEX_SHADER, vertexSource);
    let fragmentShader;
    try {
      fragmentShader = compileShader(gl.FRAGMENT_SHADER, `precision ${precision} float;\n${fragmentBody}`);
    } catch (error) {
      gl.deleteShader(vertexShader);
      throw error;
    }

    program = gl.createProgram();
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);
    gl.deleteShader(vertexShader);
    gl.deleteShader(fragmentShader);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const message = gl.getProgramInfoLog(program) || 'Unknown shader link error';
      throw new Error(message);
    }

    vertexBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);

    const position = gl.getAttribLocation(program, 'a_position');
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);

    uniforms = {
      resolution: gl.getUniformLocation(program, 'u_resolution'),
      pointer: gl.getUniformLocation(program, 'u_pointer'),
      time: gl.getUniformLocation(program, 'u_time'),
      pulse: gl.getUniformLocation(program, 'u_pulse'),
      reference: gl.getUniformLocation(program, 'u_reference')
    };

    referenceTexture = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, referenceTexture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, referenceImage);
    gl.useProgram(program);
    gl.uniform1i(uniforms.reference, 0);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    setRenderer('webgl');
  }

  function lowPowerMode() {
    return saveData || !finePointer.matches || window.innerWidth < 720;
  }

  function resize() {
    if (!gl || !program || contextLost || destroyed) return;

    const bounds = canvas.getBoundingClientRect();
    if (bounds.width < 1 || bounds.height < 1) return;

    const lowPower = lowPowerMode();
    const dprLimit = lowPower ? 1.25 : 1.75;
    let scale = Math.min(window.devicePixelRatio || 1, dprLimit);
    const pixelBudget = lowPower ? 520000 : 1100000;
    const desiredPixels = bounds.width * bounds.height * scale * scale;
    if (desiredPixels > pixelBudget) scale *= Math.sqrt(pixelBudget / desiredPixels);

    const width = Math.max(1, Math.round(bounds.width * scale));
    const height = Math.max(1, Math.round(bounds.height * scale));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
      gl.viewport(0, 0, width, height);
    }

    draw();
  }

  function queueResize() {
    if (resizeFrame) return;
    resizeFrame = requestAnimationFrame(() => {
      resizeFrame = 0;
      resize();
    });
  }

  function draw() {
    if (!gl || !program || contextLost || destroyed || canvas.width < 1 || canvas.height < 1) return;

    gl.useProgram(program);
    gl.uniform2f(uniforms.resolution, canvas.width, canvas.height);
    gl.uniform2f(uniforms.pointer, pointerX, pointerY);
    gl.uniform1f(uniforms.time, reducedMotion.matches ? STILL_PHASE : elapsed / LOOP_DURATION * Math.PI * 2);
    gl.uniform1f(uniforms.pulse, pulse);

    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  function shouldAnimate() {
    return !destroyed && !contextLost && Boolean(program) && pageActive &&
      !document.hidden && isIntersecting && !reducedMotion.matches;
  }

  function updateMotionState() {
    cancelAnimationFrame(animationFrame);
    animationFrame = 0;
    lastFrameTime = 0;

    if (reducedMotion.matches) {
      container.dataset.motion = 'still';
      pointerX = pointerY = targetPointerX = targetPointerY = pulse = 0;
      draw();
      return;
    }

    if (shouldAnimate()) {
      container.dataset.motion = 'running';
      animationFrame = requestAnimationFrame(tick);
    } else {
      container.dataset.motion = 'paused';
      draw();
    }
  }

  function tick(now) {
    if (!shouldAnimate()) {
      updateMotionState();
      return;
    }

    if (lastFrameTime) {
      const delta = Math.min((now - lastFrameTime) / 1000, 0.05);
      elapsed = (elapsed + delta) % LOOP_DURATION;
      const smoothing = 1 - Math.exp(-delta * 5.5);
      pointerX += (targetPointerX - pointerX) * smoothing;
      pointerY += (targetPointerY - pointerY) * smoothing;
      pulse *= Math.exp(-delta * 2.8);
    }
    lastFrameTime = now;
    draw();
    animationFrame = requestAnimationFrame(tick);
  }

  function onPointerMove(event) {
    if (!finePointer.matches || reducedMotion.matches) return;
    const bounds = canvas.getBoundingClientRect();
    const x = (event.clientX - bounds.left) / bounds.width;
    const y = (event.clientY - bounds.top) / bounds.height;
    if (x < 0 || x > 1 || y < 0 || y > 1) {
      onPointerLeave();
      return;
    }
    targetPointerX = x * 2 - 1;
    targetPointerY = 1 - y * 2;
  }

  function onPointerLeave() {
    targetPointerX = 0;
    targetPointerY = 0;
  }

  function onPointerDown(event) {
    if (!finePointer.matches || reducedMotion.matches) return;
    const bounds = canvas.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right ||
        event.clientY < bounds.top || event.clientY > bounds.bottom) return;
    pulse = 1;
  }

  function onVisibilityChange() {
    updateMotionState();
  }

  function onPageHide(event) {
    pageActive = false;
    updateMotionState();
    if (!event.persisted) destroy();
  }

  function onPageShow() {
    if (destroyed) return;
    pageActive = true;
    queueResize();
    updateMotionState();
  }

  function onContextLost(event) {
    event.preventDefault();
    contextLost = true;
    program = null;
    vertexBuffer = null;
    referenceTexture = null;
    uniforms = null;
    setRenderer('fallback');
    updateMotionState();
  }

  function onContextRestored() {
    if (destroyed) return;
    try {
      createGraphics();
      resize();
      updateMotionState();
    } catch (error) {
      releaseGraphics();
      setRenderer('fallback');
      updateMotionState();
      console.warn('Live orb could not restore WebGL; using the CSS fallback.', error);
    }
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    cancelAnimationFrame(animationFrame);
    cancelAnimationFrame(resizeFrame);
    observer?.disconnect();
    resizeObserver?.disconnect();
    window.removeEventListener('resize', queueResize);
    releaseGraphics();
    pointerSurface.removeEventListener('pointermove', onPointerMove);
    pointerSurface.removeEventListener('pointerleave', onPointerLeave);
    pointerSurface.removeEventListener('pointerdown', onPointerDown);
    canvas.removeEventListener('webglcontextlost', onContextLost);
    canvas.removeEventListener('webglcontextrestored', onContextRestored);
    document.removeEventListener('visibilitychange', onVisibilityChange);
    window.removeEventListener('pagehide', onPageHide);
    window.removeEventListener('pageshow', onPageShow);
    reducedMotion.removeEventListener?.('change', updateMotionState);
    finePointer.removeEventListener?.('change', queueResize);
  }

  function initialize() {
    canvas.addEventListener('webglcontextlost', onContextLost, false);
    canvas.addEventListener('webglcontextrestored', onContextRestored, false);

    try {
      createGraphics();
    } catch (error) {
      releaseGraphics();
      setRenderer('fallback');
      container.dataset.motion = 'still';
      console.warn('Live orb could not start WebGL; using the CSS fallback.', error);
      return;
    }

    pointerSurface.addEventListener('pointermove', onPointerMove, { passive: true });
    pointerSurface.addEventListener('pointerleave', onPointerLeave, { passive: true });
    pointerSurface.addEventListener('pointerdown', onPointerDown, { passive: true });
    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('pageshow', onPageShow);
    reducedMotion.addEventListener?.('change', updateMotionState);
    finePointer.addEventListener?.('change', queueResize);

    if ('ResizeObserver' in window) {
      resizeObserver = new ResizeObserver(queueResize);
      resizeObserver.observe(canvas);
    } else {
      window.addEventListener('resize', queueResize, { passive: true });
    }

    if ('IntersectionObserver' in window) {
      observer = new IntersectionObserver((entries) => {
        isIntersecting = entries.some(entry => entry.isIntersecting);
        updateMotionState();
      }, {
        root: scrollRoot || null,
        threshold: 0.01
      });
      observer.observe(container);
    }

    resize();
    updateMotionState();
  }

  referenceImage.onload = () => { if (!destroyed) initialize(); };
  referenceImage.onerror = () => setRenderer('fallback');
  referenceImage.src = new URL('orb-reference.jpg', document.baseURI).href;
})();
