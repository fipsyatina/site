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
  const STILL_PHASE = 1.4;
  container.dataset.loopDuration = String(LOOP_DURATION);

  let gl = null;
  let program = null;
  let vertexBuffer = null;
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

  const fragmentBody = `
    uniform vec2 u_resolution;
    uniform vec2 u_pointer;
    uniform float u_time;
    uniform float u_pulse;
    uniform float u_steps;

    // Two cheap rotations let the pointer turn the object without changing its
    // silhouette or making it feel like a draggable UI control.
    vec3 turnObject(vec3 p) {
      float ay = u_pointer.x * 0.18;
      float ax = -u_pointer.y * 0.12;
      float cy = cos(ay), sy = sin(ay);
      float cx = cos(ax), sx = sin(ax);
      p.xz = mat2(cy, -sy, sy, cy) * p.xz;
      p.yz = mat2(cx, -sx, sx, cx) * p.yz;
      return p;
    }

    float orbDistance(vec3 p) {
      p.y += 0.015;
      float len = length(p);
      vec3 q = turnObject(p / max(len, 0.0001));

      // u_time is a 0..2 PI phase. Integer temporal harmonics make both
      // the surface and its velocity join seamlessly every 24 seconds.
      float broad = sin(dot(q, vec3(1.55, 2.15, -1.35)) * 1.72 + u_time);
      broad *= sin(dot(q, vec3(-2.05, 1.10, 1.75)) * 1.44 - u_time * 2.0);
      float lobe = sin(q.x * 3.7 - q.y * 2.4 + q.z * 1.9 + u_time * 2.0);
      lobe += 0.55 * sin(q.y * 4.3 + q.z * 2.1 - u_time * 2.0);
      float asymmetry = 0.5 + 0.5 * dot(q, normalize(vec3(-0.7, 0.45, 0.3)));
      float ripple = u_pulse * sin(dot(q, normalize(vec3(u_pointer, 0.85))) * 11.0 - u_time * 4.0);
      float radius = 0.72 + broad * 0.07 + lobe * 0.027 + asymmetry * 0.028 + ripple * 0.012;
      return len - radius;
    }

    vec3 orbNormal(vec3 p) {
      // Tetrahedral sampling saves one map call compared with central XYZ
      // differences and is stable enough for the broad liquid-metal surface.
      const float e = 0.0022;
      vec2 h = vec2(1.0, -1.0) * 0.5773;
      return normalize(
        h.xyy * orbDistance(p + h.xyy * e) +
        h.yyx * orbDistance(p + h.yyx * e) +
        h.yxy * orbDistance(p + h.yxy * e) +
        h.xxx * orbDistance(p + h.xxx * e)
      );
    }

    float studioPanel(vec3 ray, vec3 direction, vec2 halfSize, float softness) {
      vec3 forward = normalize(direction);
      vec3 right = normalize(cross(vec3(0.0, 1.0, 0.0), forward));
      vec3 up = cross(forward, right);
      float depth = dot(ray, forward);
      vec2 panelUv = vec2(dot(ray, right), dot(ray, up)) / max(depth, 0.08);
      float boxDistance = max(abs(panelUv.x) - halfSize.x, abs(panelUv.y) - halfSize.y);
      return (1.0 - smoothstep(-softness, softness, boxDistance)) * smoothstep(0.05, 0.42, depth);
    }

    void main() {
      vec2 uv = (gl_FragCoord.xy * 2.0 - u_resolution.xy) / min(u_resolution.x, u_resolution.y);
      vec3 rayOrigin = vec3(0.0, 0.015, 2.65);
      vec3 rayDirection = normalize(vec3(uv * 1.02, -2.2));

      // Start at a conservative bounding sphere, leaving the raymarch budget
      // for the liquid surface and its grazing silhouette rather than empty space.
      float projection = dot(rayOrigin, rayDirection);
      float discriminant = projection * projection - dot(rayOrigin, rayOrigin) + 0.90 * 0.90;
      if (discriminant < 0.0) {
        gl_FragColor = vec4(0.0);
        return;
      }
      float travel = max(0.0, -projection - sqrt(discriminant));
      float farSurface = -projection + sqrt(discriminant);
      float distanceToSurface = 0.0;
      bool hit = false;

      // The hard ceiling keeps GPU cost predictable. u_steps selects a lower
      // budget on small/coarse/save-data devices without compiling a variant.
      for (int i = 0; i < 64; i++) {
        if (float(i) >= u_steps) break;
        vec3 p = rayOrigin + rayDirection * travel;
        distanceToSurface = orbDistance(p);
        if (distanceToSurface < 0.0015) {
          hit = true;
          break;
        }
        if (travel > farSurface) break;
        travel += max(distanceToSurface * 0.55, 0.0005);
      }

      if (!hit) {
        gl_FragColor = vec4(0.0);
        return;
      }

      vec3 position = rayOrigin + rayDirection * travel;
      vec3 normal = orbNormal(position);
      vec3 view = normalize(rayOrigin - position);
      vec3 reflected = reflect(-view, normal);
      float facing = max(dot(normal, view), 0.0);
      float fresnel = pow(1.0 - facing, 3.2);

      // Soft rectangular sources mimic a dark photographic studio: the face
      // stays nearly black while two silver cards describe the curved volume.
      float leftPanel = studioPanel(reflected, vec3(-0.66, 0.55, 0.62), vec2(0.34, 0.59), 0.22);
      float rightPanel = studioPanel(reflected, vec3(0.76, 0.39, 0.54), vec2(0.34, 0.48), 0.19);
      float topPanel = studioPanel(reflected, vec3(-0.08, 0.93, 0.34), vec2(0.52, 0.16), 0.24);
      float foldedSheen = pow(max(0.0, 0.5 + 0.5 * dot(reflected, normalize(vec3(-0.42, 0.2, 0.88)))), 3.2);
      foldedSheen *= 0.55 + 0.45 * sin(normal.y * 5.0 + normal.x * 2.0);

      vec3 base = vec3(0.006, 0.007, 0.008);
      vec3 silver = vec3(0.47, 0.485, 0.50);
      vec3 color = base;
      color += silver * leftPanel * 0.54;
      color += silver * rightPanel * 0.42;
      color += silver * topPanel * 0.10;
      color += vec3(0.08, 0.082, 0.085) * foldedSheen;
      color += vec3(0.048, 0.051, 0.054) * fresnel;
      color += vec3(0.012) * max(normal.y, 0.0);
      color *= 0.92 + 0.08 * smoothstep(-0.7, 0.8, normal.y);

      // Blend the original dark material with exactly one percent white.
      color = mix(color, vec3(1.0), 0.01);
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
      steps: gl.getUniformLocation(program, 'u_steps')
    };

    gl.useProgram(program);
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
    gl.uniform1f(uniforms.steps, lowPowerMode() ? 48 : 64);
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

  initialize();
})();
