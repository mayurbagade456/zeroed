# ZEROED

Human sensory calibration benchmark. Three five-round games, 50.0 max score, no backend:

- **Sound**: recall a pitch (220–880 Hz) and tune it by dragging.
- **Color**: memorize a color, then rebuild it with hue / saturation / brightness strips.
- **Time**: hold for an exact duration with no timer.

Practice mode uses random targets. Daily Benchmark generates the same targets for everyone from the UTC date (Mulberry32). Scoring has three stages (Gentle, Balanced, Strict).

Everything lives in browser memory. Nothing is stored or sent.

## Run

```
npm install
npm run dev
```

Build with `npm run build`. The whole app is in `src/App.tsx`.

Stack: React, TypeScript, Vite, Tailwind CSS v4, Framer Motion.
