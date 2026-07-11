# Box Silhouette Detection

This is the first diagnostic stage of the box-to-flat-cover workflow. It finds the largest object against a mostly flat image background and simplifies its convex hull to six lines.

The detector deliberately does not select or warp the front panel yet. Its outputs make the silhouette geometry visible before later stages depend on it:

- `silhouette-overlay.png`: numbered polygon lines and vertices over the source image.
- `silhouette-mask.png`: foreground pixels used to find the box.
- `silhouette.json`: vertices, line endpoints, line angles, and fit metrics.

Run it from `ludora-admin/ludora-discovery`:

```powershell
$env:PYTHONPATH = "src"
python scripts/detect_box_silhouette.py "C:\path\to\box.png" --output-dir "artifacts\box-silhouette"
```

The default background threshold is estimated from the image border. For a noisy or slightly tinted flat background it can be overridden:

```powershell
python scripts/detect_box_silhouette.py "C:\path\to\box.jpg" --output-dir "artifacts\box-silhouette" --background-threshold 12
```

This first version assumes one fully visible box on a mostly uniform background. Busy scenes, cropped boxes, strong cast shadows, or non-convex packaging should be rejected or sent to a later review/manual-corner path rather than silently treated as reliable geometry.
