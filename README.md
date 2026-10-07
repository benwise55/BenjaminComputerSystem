# College Football Ratings Dashboard

Standalone, static web application for college football ratings, predictions, and simulations.

## Deployment

This directory contains pure static HTML, CSS, JavaScript, and pre-computed JSON data. No backend or database is needed.

### Cloudflare Pages
1. Run `npx wrangler pages deploy .` or connect your Git repository.
2. Set build output directory to `.` (or `cfb_dashboard_site`).

### Netlify
- Drag and drop this folder directly into [Netlify Drop](https://app.netlify.com/drop).

### GitHub Pages
- Push this folder to a GitHub repository and enable GitHub Pages in Settings -> Pages.

### Local Testing
```bash
python3 -m http.server 8000
```
Then open `http://localhost:8000` in your browser.
