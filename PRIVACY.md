# Local privacy model

MiniMax H3 Studio is designed to keep generation data on the computer running
the app.

- The web interface talks only to the API bound to `127.0.0.1`.
- The API talks only to the local MLX server bound to `127.0.0.1`.
- Prompts, reference images, output filenames, generated videos, posters, and
  generation metadata are runtime data and are not part of the source tree.
- Runtime storage, environment files, uploads, media, and model output formats
  are excluded by `.gitignore`.
- `npm run privacy:check` audits every file Git could publish and blocks known
  runtime data, personal absolute paths, and embedded image data.

The application has no analytics, telemetry, cloud upload, authentication, or
remote generation integration. Publishing this repository publishes source code
only. It does not publish local generation data.

Run this before every public push:

```bash
npm run privacy:check
```

The included `.githooks/pre-push` hook runs the same audit automatically.
