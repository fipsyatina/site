# fipsyatina

Static personal website, served directly by GitHub Pages. No build step or npm dependencies.

## Local preview

Run from this directory:

```sh
python -m http.server 8765 --bind 127.0.0.1
```

Open http://127.0.0.1:8765/.

## Live orb

`orb-reference.jpg` is the frame at 4 seconds from the original `anim.mp4`. `orb.js` preserves that frame's dark material, grain, and reflections, and animates it with periodic WebGL texture deformation. This is an animated image surface, not a reconstructed 3D model. The 24-second cycle returns seamlessly to its starting appearance without buttons or video playback. Pointer movement gently shifts the surface; clicking adds a ripple.

- Reduced motion: a still frame with pointer effects disabled.
- Offscreen or hidden page: rendering pauses and resumes when visible again.
- Touch, small screens, or Save-Data: lower rendering budgets; pointer effects require a fine hover pointer.
- WebGL unavailable or lost: the reference still remains visible. Rendering resumes if the context is restored.
- No JavaScript: the reference still remains visible.

To tune the motion, edit the periodic flow in `fragmentBody` inside `orb.js`. The source frame controls the appearance; `resize()` caps pixel density and total pixels.

`anim.mp4` is preserved as the original reference and is no longer requested by the page. The existing Pages workflow publishes only pushes to `main`; a local feature branch does not update the public website.
