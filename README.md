## MWRA 2024 Water Quality Dashboard

GitHub repository: <https://github.com/kavya-anbarasu/MWRA_2024_EDA>

Live dashboard: <https://kavya-anbarasu.github.io/MWRA_2024_EDA/>

This repository now includes a static dashboard for the 2024 MWRA monitoring
data. It uses the bundled CSV/XLSX files to show:

- Station map overlay with nearfield and outfall reference layers
- Parameter summaries by station, survey event, depth, and region
- Water-column depth profiles and time-depth heatmaps
- Lab nutrient overlays for dissolved nitrogen and phosphorus
- Phytoplankton and zooplankton group summaries

### Run Locally

Serve the repository root with any static file server:

```bash
python3 -m http.server 8000
```

Then open `http://localhost:8000`.

### Regenerate Dashboard Data

The browser data bundle is generated from the source files in `data/`:

```bash
python3 scripts/build_dashboard_data.py
```

This rewrites `assets/mwra_dashboard_data.js`.

### Deploy

The dashboard is static. Deploy the repository root to Vercel, Netlify, GitHub
Pages, or any host that serves `index.html`, `assets/`, and `data/`.

For GitHub Pages, serve from the repository root of the `main` branch. For
Vercel or Netlify, no build command is required and the publish directory is
the repository root.

The original Dash prototype files are still present for reference, but the
deployable site is the static dashboard at `index.html`.
