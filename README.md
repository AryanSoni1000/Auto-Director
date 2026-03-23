# Auto-Director

Auto-Director is a lightweight web app for the hackathon brief. It turns a one-line prompt into a 3-act cinematic storyboard feed with:

- a screenwriter pass
- a cinematographer pass
- a visual artist pass

The project runs with plain Node.js and no npm dependencies, so it works immediately in demo mode and can switch to live Gemini-powered story generation plus Gemini-powered image generation when an API key is available.

## Run

```bash
node server.mjs
```

Then open [http://localhost:3000](http://localhost:3000).

For auto-reload while iterating:

```bash
node --watch server.mjs
```

## Modes

### Demo mode

No API key required.

- narrative generation uses a deterministic local fallback
- visuals are generated as cinematic SVG poster frames
- useful for local demos, UI work, and offline verification

### Live mode

Create a `.env` file in `/Users/avayaavijit/Downloads/TECH` based on [`.env.example`](/Users/avayaavijit/Downloads/TECH/.env.example):

```bash
GEMINI_API_KEY=AIzaSyBCODeyoHEb5G0jSwTOxjx1AF2hQgBfjDY
GEMINI_IMAGE_API_KEY=AIzaSyAMLxi3aoFzS7YZWa5vAfUFhtNbAv4EATk
GEMINI_TEXT_MODEL=gemini-2.5-flash
GEMINI_IMAGE_MODEL=gemini-2.5-flash-image
GEMINI_IMAGE_MODE=live
GEMINI_IMAGE_SIZE=1024x1536
PORT=3000
```

- when `GEMINI_API_KEY` is present, the screenwriter and cinematographer run through the Gemini API with JSON schema output
- when `GEMINI_IMAGE_API_KEY` is present and `GEMINI_IMAGE_MODE=live`, the visual artist generates real shot images through Google's image generation endpoint
- the app can still fall back to poster visuals if live image generation is disabled or unavailable

## Files

- [server.mjs](/Users/avayaavijit/Downloads/TECH/server.mjs): HTTP server, AI pipeline, poster generation
- [public/index.html](/Users/avayaavijit/Downloads/TECH/public/index.html): app shell and templates
- [public/styles.css](/Users/avayaavijit/Downloads/TECH/public/styles.css): cinematic feed styling
- [public/app.js](/Users/avayaavijit/Downloads/TECH/public/app.js): client-side rendering and interactions

## Notes

- The app is intentionally dependency-light so it is easy to submit, inspect, and deploy.
- If live Gemini text or Gemini image calls fail, the server automatically falls back instead of breaking the experience.
