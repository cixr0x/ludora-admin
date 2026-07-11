# Box Silhouette Detection

This is the first diagnostic stage of the box-to-flat-cover workflow. It finds the largest object against a mostly flat image background, uses its convex hull as a coarse location, and then fits six straight lines to the source-image boundary.

The convex hull does not define the final corners. It only initializes the six expected sides. The detector finds straight source-image segments near each side, prefers high-contrast box edges over lower-contrast cast-shadow edges, robustly fits each boundary line, and calculates subpixel corners from adjacent line intersections. A mask-hull line is used only when the real boundary is effectively invisible, such as a white box edge against a white background.

The detector deliberately does not select or warp the front panel yet. Its outputs make the silhouette geometry visible before later stages depend on it:

- `silhouette-overlay.png`: numbered polygon lines and vertices over the source image.
- `silhouette-mask.png`: foreground pixels used to find the box.
- `silhouette.json`: vertices, line endpoints, line angles, and fit metrics.

In the overlay, red is the final fitted six-line silhouette, blue is the old six-point hull approximation, and the thinner cyan trace is the unsimplified convex hull. Each JSON line records whether it was fitted from an `image_edge` or inferred from the `mask_hull`.

## Perspective Classification

The six clockwise lines are labeled `A1 B1 C1 A2 B2 C2`. The detector compares the direction of each opposite pair: `A1-A2`, `B1-B2`, and `C1-C2`. Directions are compared modulo 180 degrees with a 12-degree tolerance.

- Three matching pairs: `three_faces`, high confidence.
- Two matching pairs: `three_faces`, lower confidence because one receding axis may converge strongly under projective perspective.
- One matching pair: `two_faces`.
- No matching pairs, or an outline without six sides: `ambiguous`.

The JSON includes both line angles, their angular difference, whether they match, and their finite vanishing point when the lines are not nearly parallel. This evidence is retained so later stages can reject borderline classifications or add an interior-edge check.

## Two-Face Cover Identification

When exactly one opposite line pair matches, the four vertices incident to that pair belong to the outer vertical boundaries. The remaining two vertices are connected to form the shared seam between the visible faces. That seam divides the hexagon into two quadrilaterals; the larger quadrilateral is selected as the front cover and the smaller as the side face.

The overlay draws the inferred seam in magenta and shades the selected cover green. The JSON records the parallel pair, seam endpoints, both face polygons and areas, and the fraction of the combined visible-face area assigned to the cover.

## Three-Face Cover Construction: First Case

The first three-face experiment performs exactly two translations without changing either source direction:

1. Copy `C2` and translate it until it passes through vertex `V2`.
2. Copy `B2` and translate it until it passes through vertex `V4`.
3. Intersect the translated lines to obtain the missing cover corner.
4. Form the cover quadrilateral from `V2`, `V3`, `V4`, and the intersection.

`three-face-cover.png` draws the original `C2/B2` source segments in cyan and their translated copies in magenta. The JSON records both source and translated segments and their angular errors, which should be zero apart from floating-point precision. No alternative slope combinations are generated in this experiment.

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
