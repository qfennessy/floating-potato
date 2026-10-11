# Assets

Created 2026-10-11 · Last edited 2026-10-11

## venus_magellan.jpg

Magellan radar map of all of Venus, used as the background for the demo map.

| Field | Value |
|---|---|
| Source | USGS Astrogeology, Venus Magellan C3-MDIR Global Mosaic 2025m |
| Download URL | https://planetarymaps.usgs.gov/mosaic/Venus_Magellan_C3-MDIR_Global_Mosaic_2025m.tif |
| Credit | NASA / JPL / USGS. Public domain (US government work). |
| Projection | Equirectangular (simple cylindrical) |
| Longitude | -180 (left edge) to +180 (right edge), 0° in the center, east positive |
| Latitude | +90 (top edge) to -90 (bottom edge) |
| Pixel size | 4096 × 2048, grayscale JPEG (downsampled from 18775 × 9388 GeoTIFF, 2025 m/pixel) |

Pixel to coordinates: `lon = x / 4096 * 360 - 180`, `lat = 90 - y / 2048 * 180`.

Known quirks: the raw mosaic has black gaps where Magellan collected no data. The biggest are near the poles and in thin vertical strips. The bottom edge (south of about 85°S) is black.
