# Background Remover — source

Full source for the app deployed at the repo root (GitHub Pages, /Background/).

This folder exists so the source survives — the deployed root holds only the
built output. To work on it:

```
cd source
npm install
npm run dev      # local dev
npm run build    # outputs dist/ — copy dist/. to the repo root to deploy
```

Stack: React 18 + Vite + TypeScript + Tailwind. No backend.
