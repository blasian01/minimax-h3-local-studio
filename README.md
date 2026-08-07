# MiniMax H3 Local Studio

A small open-source React interface for running MiniMax H3 video generation locally on Apple Silicon through [`mlx-serve`](https://github.com/ddalcu/mlx-serve).

## Features

- Chat-style prompt interface
- Fixed 864×480 landscape generation
- Optional drag-and-drop first-frame reference image
- 5- and 10-second exports
- Model-side fast step caching
- Disk cache for identical prompt, seed, duration, and reference combinations
- Local generation archive with playback and MP4 downloads
- Generated media remains on your machine

## Requirements

- macOS on Apple Silicon
- Node.js 22.13 or later
- FFmpeg and `jq`
- `mlx-serve`
- A local MiniMax H3 MLX checkpoint

## Start the model

```bash
mlx-serve \
  --model "/path/to/MiniMax-H3-FL2VA-MLX-Serve-8bit" \
  --serve \
  --host 127.0.0.1 \
  --port 11234 \
  --timeout 0
```

## Start the studio

```bash
cp .env.example .env.local
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). The local companion API runs on port `8787`.

## Direct 864×480 generation without a reference

The `fast` option enables MiniMax H3's step-cache and attention-broadcast acceleration.

```bash
PROMPT='<YOUR_PROMPT>'

jq -n --arg prompt "$PROMPT" '{
  prompt: $prompt,
  width: 864,
  height: 480,
  num_frames: 120,
  steps: 30,
  seed: 20260806,
  fast: true
}' |
curl --fail-with-body --max-time 0 \
  -H "Content-Type: application/json" \
  --data-binary @- \
  http://127.0.0.1:11234/v1/video/generations \
  -o /tmp/minimax-response.json
```

The web studio performs the remaining raw-frame/audio conversion automatically and stores completed MP4 files in `GENERATION_DIR`.

## Privacy

The app binds its model and companion API to `127.0.0.1`. It does not upload prompts, filenames, reference images, generation history, or generated videos to GitHub or any hosted service. Runtime media lives only in the ignored `GENERATION_DIR` configured on each machine.

Before publishing source changes, run:

```bash
npm run privacy:check
```

This rejects tracked environment files, media outputs, caches, personal filesystem paths, and embedded reference-image data.
The repository also configures this check as a local pre-push hook, so a failed
privacy audit stops the push.

## License

MIT. MiniMax H3 model weights remain governed by their own license.
