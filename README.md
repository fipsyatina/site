# fipsyatina

Static personal website, served directly by GitHub Pages. No build step or npm dependencies.

## Local preview

Run from this directory:

```sh
python -m http.server 8765 --bind 127.0.0.1
```

Open http://127.0.0.1:8765/.

## Live orb

`orb.js` renders a graphite liquid-metal surface with silver studio reflections in WebGL. The shape is calculated for each frame and repeats seamlessly every 24 seconds; no video or external textures are used. The animation runs automatically without buttons. Move a mouse over the orb to gently turn the surface, or click it for a small ripple.

- Reduced motion: a still frame with pointer effects disabled.
- Offscreen or hidden page: rendering pauses and resumes when visible again.
- Touch, small screens, or Save-Data: lower rendering budgets; pointer effects require a fine hover pointer.
- WebGL unavailable or lost: the CSS chrome still remains visible. Rendering resumes if the context is restored.
- No JavaScript: the CSS still remains visible.

To tune the appearance, edit `orbDistance()` (shape and speed) and the studio panels in the fragment shader inside `orb.js`. `resize()` caps pixel density and total pixels; `lowPowerMode()` selects the smaller raymarch budget.

`anim.mp4` is preserved as the original reference and is no longer requested by the page. The existing Pages workflow publishes only pushes to `main`; a local feature branch does not update the public website.
