# flat-earth

A world map on an oblique cylindrical projection: rotate the globe so that any
point on Earth lands at the origin, then unroll it. Wherever you centre it is
where the map is least distorted — so it is a "correct" map of that place, and
everything else gets progressively stranger.

Pick a country from the panel, or set the centre with the sliders. Dragging the
map re-centres it too, rather than sliding off into a corner of the projection.
Vector country outlines, with satellite or map imagery underneath.

## The panel

The UI is [guspira](https://github.com/spite/guspira) (v0.1.1, vendored into
`third_party/guspira/`), which is signal-based rather than object-and-poll. Every
control binds a signal, and the signal *is* the value -- so re-centring from a map
click writes `centreLon`/`centreLat` and the sliders follow on their own. The
dat.GUI version needed an `updateDisplay()` call after every programmatic write
to keep the panel and the state from drifting apart; that whole class of bug is
gone.

The wiring is one effect per thing it drives, each running once on creation, so
the effects double as the initial state -- including the first mosaic loads:

```js
effect(() => (rasterUniforms.exaggeration.value = exaggeration()));
effect(() => loadImagery(imagerySource(), imageryZoom()));
```

Two behaviours worth knowing. The country dropdown recentres through `onChange`,
which fires on user input but not on programmatic writes -- so clearing the
selection when the map is dragged does not drag the centre back to the old
country.
And the terrain rows use `disabledWhen`, so a control that cannot currently do
anything says so. The group greys out when shading is off, and the lighting
controls -- exaggeration, sun azimuth, sun altitude -- also grey out at zero
shading strength, because the shader skips the hillshade branch entirely there.
Without that they stay live and inert: numbers moving, nothing happening.

## Sharing a view

The address bar carries the whole view: projection centre, camera zoom and pan,
projection, imagery source and layer settings. Copy the URL and the same pixels
come back, which is also how a bug report becomes a test case.

```
#lon=3.02&lat=39.6&zoom=335544&px=0&py=0&proj=mercator&img=Esri+satellite
```

Only what differs from the default is written, so a URL stays short. The table
lives in `js/view-state.js` and is read in both directions -- a signal cannot be
added to it without being persisted.

| key | meaning |
| --- | --- |
| `lon`, `lat` | the point the projection is centred on |
| `zoom` | camera zoom (1 fits the world) |
| `px`, `py` | camera pan, in plane degrees |
| `proj` | `mercator` or `equirectangular` |
| `img`, `opacity` | imagery source and opacity |
| `detail=0` | window layer off, backstop only |
| `shading=0`, `terrainsrc` | terrain shading off; elevation source |
| `relief`, `exag` | hillshade strength, vertical exaggeration |
| `sunaz`, `sunalt` | sun azimuth and altitude |
| `shadows=1`, `shadowstr`, `shadowsteps` | cast shadows and their tuning |
| `watersrc`, `waterlevel` | water mask source and threshold |
| `waterfill=1`, `watertint` | flat fill over water, and its colour |
| `outlines`, `graticule`, `country`, `ui` | overlays and selection |
| `tiles=1`, `tint`, `mosaic=1` | diagnostics |

## Diagnosing a bad render

Two switches split the pipeline in half.

**Show raw mosaic** (`mosaic=1`) draws the detail mosaic straight to the screen
with no projection involved. If a fault is visible there it was baked into the
canvas when the tiles were fetched and composited -- a CPU-side bug, reproducible
anywhere. If the mosaic is clean and only the map is wrong, the fault arrives when
the map samples it, which is shader and driver territory.

**Show tiles** (`tiles=1`) colours and outlines each tile. Note that this is a
debug view of a debug view: its own coordinates come from the same maths as the
imagery, so a fault in the projection shows up in the grid too.

The status overlay reports the detail zoom, the window size in tiles, and the
viewport with its device pixel ratio -- that last part matters, because the URL
cannot carry it and the window a view needs depends on it entirely.

## Running

Needs a static server — ES modules and `fetch` do not work over `file://`.

```
python3 -m http.server 8000
```

then open <http://localhost:8000>.

## How it works

`js/projection.js` holds the projection, once as GLSL and once as JavaScript.
Both do the same thing:

1. Turn lon/lat into a point on the unit sphere.
2. Rotate by `+centreLon` about Y, then `-centreLat` about X, which sends the
   centre to (0, 0).
3. Read the rotated point back out as lon/lat.
4. Lay that on the plane, either as-is (equirectangular) or through Mercator's
   `ln(tan(π/4 + φ/2))`.

The GLSL version runs per-vertex, so re-centring is free. The JavaScript version
exists to run step 2 backwards, turning where the camera has been dragged to
into the real lon/lat that should become the new centre.

Outlines are drawn as `LineSegments`, and every vertex carries the *other* end of
its own segment as a second attribute. A segment whose two ends land more than
180° apart in longitude has wrapped around the back of the globe, so the vertex
shader pushes it outside the clip volume rather than letting it streak across the
map. This is why the antimeridian is clean at any centre.

Country outlines are lines, not filled polygons, so a landmass rotated over a
pole leaves a small gap there instead of running along the top edge — closing
that would need real polygon clipping.

## Imagery

Outlines are drawn forwards, one vertex at a time. Imagery has to run the same
projection *backwards*: one quad covers the map, and each fragment asks which
point on Earth it is showing — inverse Mercator, then the inverse rotation, then
a lookup.

The lookup is a single global Web Mercator mosaic, built once by
`js/mosaic.js` from `2^zoom` squared tiles composited into one canvas. The
oblique projection scatters the whole globe across the view at once, so there is
no useful "visible tile set" to stream — any centre can pull from anywhere. And
because the mosaic *is* the Web Mercator world, a real lon/lat maps to a UV with
the plain Mercator formula: the shader never has to know tiles exist.

The imagery quad is fitted to the visible slice of the plane each frame, clamped
to the map itself, rather than spanning the whole world. This matters more than it
sounds: `vPlane` is a varying, and interpolating it across a primitive thousands
of times wider than the view quantises it. Detail collapses into constant blocks
-- imagery smeared and repeated in bands -- and deep enough in, the quad's two
triangles disagree badly enough that the split shows as a diagonal across the
screen. Fitting the quad keeps the interpolated range small and the coordinates
precise. Clamping to the map is what stops the world repeating past its own edges,
since the base mosaic wraps in x.

Two details keep it clean. Longitude wraps, so at the antimeridian the texture
derivative jumps by a whole texture width and the automatic mip selection paints
a blurred seam down the map — the shader unwraps the gradients and samples with
`textureGrad` instead. And Web Mercator has no data above 85.05°, so the polar
caps are clamped to the edge of coverage rather than left as holes; both caps
really are ice, so the smear reads correctly.

## Terrain shading

Elevation comes from the same machinery: a second window of terrarium tiles on
the same footprint as the imagery, where height in metres is
`r * 256 + g + b / 256 - 32768`. Its zoom is capped well below the imagery's,
because a hillshade is low-frequency and gains nothing from matching it. The default
source is AWS Open Data, which hosts the Tilezen terrain set with no key and no
rate limit. Nextzen serves the same data and is selectable, but throttles hard
enough that a 256-tile mosaic will not complete. The fragment shader takes four neighbouring taps, builds a surface
normal and lambert-shades it against a movable sun.

Three things that matter:

- The heights are decoded on the CPU into a **half-float** texture rather than
  sampled as raw RGB. Bilinear filtering of terrarium bytes interpolates the
  channels independently, so every place `g` wraps past 255 -- once per 256
  metres of elevation -- would spike into a false cliff. Half float quantises to
  about 10m at Everest, invisible against a texel kilometres wide, and unlike
  full float it is filterable in core WebGL2.
- The mosaic canvas is **primed to sea level** (`rgb(128, 0, 0)`) before tiles
  are drawn. An untouched canvas pixel is `(0, 0, 0)`, which decodes to -32768m,
  so any gap would be a bottomless pit gouged into the hillshade.
- Shading is divided through by the flat-ground response, so level terrain comes
  back at 1.0 and the strength slider only ever adds relief, never overall
  darkness. Vertical exaggeration is a separate control: at world scale one
  texel spans kilometres and true slopes are far too gentle to read.

**Cast shadows** march the heightfield toward the sun, a texel a step, and ask
whether anything upwind rises above the ray. The heightfield is already in a
texture and the metres-per-texel is already known, so the walk needs nothing new
-- and because the sun angle is only a comparison, dragging either sun slider
stays free. A 4000m peak at a 25 degree sun throws about 40 texels at the levels
the window uses, so 64 steps covers real terrain.

Terrain outside the window cannot be consulted, and a blocker just off screen
still casts into view, so switching shadows on grows the elevation window by a
ring. That ring is *not* charged against the tile budget: when it was, asking for
shadows quietly cost a zoom level of relief, because the larger block no longer
fit and the probe stepped down.

Lighting is computed in Earth's frame, not the screen's, so the sun stays fixed
relative to the terrain and the shading rotates with the map rather than the
viewer.

A rate-limited response usually carries no CORS header, so the browser blocks it
and the status never reaches JavaScript -- a 429 arrives as an indistinguishable
network failure. The tile loader therefore treats *any* failure as possible
throttling, and backs off across the whole worker pool rather than per request:
retrying one tile while the rest keep firing is what holds a server over its
limit in the first place.

## Detail on demand

The world mosaic caps out around 9.8km per texel, so zooming in used to just
magnify blur. On top of it sits a **detail window**: a second mosaic covering only
the block of tiles currently visible, at a zoom matched to the screen.

```
window (what you are looking at)  +  backstop (whole world, coarse)

shader:  tile  = uv * 2^windowZoom
         local = (tile - window.xy) / window.zw
         inside [0,1]?  window  :  backstop
```

Both imagery and elevation are windows on the visible footprint, at every zoom
including fully out -- where the footprint simply *is* the whole world and the
probe returns it at a low level. The whole-world mosaic is no longer the picture;
it is a backstop, there to fill the screen while a window loads and to cover
anywhere the footprint sampling does not reach. Tying the window's lower bound to
the backstop, as this first did, meant a coarse backstop suppressed the window
entirely and the view paid for a whole world it could not see.

A window is not rebuilt when the view moves. `js/tile-grid.js` keeps the canvas
and slides it: the overlap carries over in one blit, and only the tiles the move
exposed are queued, nearest the centre first. Nothing is aborted, so a tile
fetched once is never fetched again however much you pan around it. Rebuilding
instead refetched and repainted the whole window, which read as the map
flickering while nothing about it had changed.

Coverage is what makes a half-filled window safe to draw: a tile that has not
landed leaves alpha at zero and the shader falls through to the backstop rather
than punching a hole. The rim is feathered so the hand-off is not a visible
rectangle.

`js/elevation-grid.js` does the same for the heightfield, with one difference.
The shadow march's max pyramid is derived from the whole field and cannot be
filled a tile at a time, so loading and showing are separated: tiles stream into
a pending field, and the screen keeps the last complete window until the new one
is finished and its pyramid rebuilt. Relief is briefly stale rather than briefly
wrong -- a half-filled field reads as sea level, which puts a cliff at the window
edge, and a pyramid from the previous window has the march reading maxima from
the wrong place.

`js/visibility.js` decides what is needed. The map is an arbitrary rotation, so
the visible footprint in true lon/lat is not a rectangle and cannot be bounded
analytically -- near the poles and the antimeridian it folds back on itself. So it
is probed rather than derived: sample the screen on a 24×24 grid and push each
point through the same inverse the fragment shader uses. Scale varies by orders of
magnitude across an oblique frame, so the zoom comes from the **median** of the
per-sample scale; a mean would be dragged away by the stretched edges. A footprint
straddling the antimeridian arrives as two clusters at opposite ends, and is made
contiguous again by lifting the low one a whole world.

The level is chosen by **rounding** that scale in log space, which lands on the
zoom whose texels come closest to 1:1 with screen pixels -- within a factor of
root two either way. Flooring instead would put a texel across one to two pixels:
never sharper than the screen, and up to twice as blurry.

When the block at that level needs more tiles than the budget allows, the probe
**steps down a level** rather than giving up. That matters more than it sounds:
the block at a fixed level shrinks as you zoom in, so taking the finest level that
fits makes the chosen zoom rise monotonically with the camera. Returning nothing
instead dropped refinement back to the base mosaic for most of every zoom level,
snapping in again only once the block shrank under the cap.

When the probe finds the base is already as sharp as the screen -- the whole
zoomed-out case -- it returns nothing and the base is used unchanged, rather than
that being a special case anywhere else.

Every layer streams, so nothing waits for the view to settle. Decoded tiles are
also kept in an LRU sized to the viewport: a fixed 128 sat below one screenful
once three layers shared it, so panning back refetched what had just been
evicted -- 472 requests over a pan-away-and-back cycle against 260 once it was
sized properly. The tile budget follows the viewport too, since a fixed cap
starves a large or HiDPI screen, and is held to 16 tiles a side so the canvas
never exceeds 4096px.

Two things keep the fetch honest, and both were measured rather than assumed.
The block is cut to the visible footprint with **no margin ring**: a ring costs
two extra tiles on each axis, which on a typical 5x4 footprint is more than half
the fetch, and it buys only rebuilds, not requests -- the decoded-tile cache
already covers a pan, and the block is tile-aligned so small pans do not move it
at all. In-flight tiles are tracked as well as loaded ones, because a window change
would otherwise requeue everything still in the air -- on a slow connection that
measured 33 requests for 21 distinct tiles, one of them fetched four times.

The backstop zoom is fixed; the window zoom is automatic, and "Window layer"
turns the window off and leaves the backstop showing.

**Show tiles** colours and outlines every tile. The colour is a hash of the
tile's own coordinates, so a tile keeps its colour while you pan instead of the
pattern sliding around with the view. The grid drawn is the one that fragment
actually sampled -- the base mosaic's, or the detail window's where it takes
over -- which makes the hand-off between them visible, and the window's extent
obvious. Border width comes from the already-unwrapped derivatives rather than
`fwidth`, which would spike at the antimeridian and paint a false seam line down
the map.

The two backstops -- whole-world imagery and whole-world relief -- are the only
layers still built in one go, by `js/layer.js`, since neither depends on the
view. Hiding a layer keeps its texture, so turning it back on is instant rather
than refetching every tile: visibility and loading are separate concerns.

Sources are in `js/tile-providers.js`, adapted from `../BlockyEarth/mapbox.js`.
All of them send `Access-Control-Allow-Origin`, which matters because the tiles
go through a 2D canvas before upload — a tile without CORS taints the canvas and
the texture upload throws. OpenTopoMap is in BlockyEarth's list but sends no CORS
header, so it needs a proxy and is left out.

BlockyEarth's `google-maps.js` is also left out: it reads `khm1.google.com/kh/v=…`,
Google's private Keyhole endpoint, with a version number scraped from a remote
script. Google's sanctioned route is the keyed Map Tiles API. Esri World Imagery
is the closest legitimate substitute and is the default here.

## Data

`data/world.json` is what the app fetches, and it is committed. It is generated
from a Natural Earth 10m admin-0 source, which is not:

```
node tools/fetch-world-source.mjs   # only if you have no source yet
node tools/build-world.mjs
```

The build drops 165 unused properties per feature and simplifies every ring with
Douglas-Peucker at 0.02° (~2km). From the original `data/custom.json` that is
30.7MB down to 1.71MB, 248 countries, reproducing the committed file byte for
byte.

That `custom.json` was a custom Natural Earth export — lowercased field names,
no Antarctica — and is not a public artefact, so it is gitignored rather than
carried in the repository at 30MB a clone. `fetch-world-source.mjs` gets the
published set instead: 13.3MB, uppercase field names, **258 countries including
Antarctica**, building to 1.83MB. The build reads either file and either casing,
so both work; rebuilding from the published source gives a slightly fuller world
than the one checked in.
