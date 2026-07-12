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

## Three-Face Cover Constructions

The constructions are derived from geometry rather than fixed labels:

1. Select the four longest silhouette lines.
2. Find vertices where two selected lines meet. A valid cuboid outline should produce exactly two such vertices.
3. For each source line, find the closest silhouette vertex that is not one of that line's endpoints.
4. Copy the source line without rotating it and translate the copy through that closest vertex.
5. Intersect the two translated lines and combine that point with their anchors and the opposite silhouette vertex.

For the current example this automatically reproduces `C2@V2 + B2@V4` and `B1@V1 + C1@V5`; those labels are results of the general rule, not hardcoded cases.

`three-face-covers.png` draws both constructions side by side. Original source segments are cyan and translated copies are magenta. The JSON records both source and translated segments and their angular errors, which should be zero apart from floating-point precision. No mixed source-line combinations are generated.

## Shared Cover Flattening

Two-face and three-face paths use different methods to find cover quadrilaterals, but every accepted quadrilateral uses the same flattening stage:

1. Order corners as top-left, top-right, bottom-right, and bottom-left.
2. Measure all four Euclidean edge lengths.
3. Estimate width from the average of the top and bottom lengths.
4. Estimate height from the average of the left and right lengths.
5. Map the quadrilateral to an axis-aligned rectangle with `cv2.getPerspectiveTransform` and `cv2.warpPerspective`.

The JSON records the four source lengths, estimated dimensions, output size, aspect ratio, and opposite-edge disagreement. Individual results are written as `flattened-cover.png` or numbered `flattened-cover-N.png` files, with a combined `flattened-cover-previews.png` for candidate comparison. Rotation is implicit in the perspective transform; rotating a line does not change its measured Euclidean length.

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
