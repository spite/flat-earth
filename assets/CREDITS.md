# Assets

Files in this directory are not covered by the repository's licence. They come
from third parties and keep their own terms.

## Paper texture

`Watercolor_ColdPress.webp` — the green channel of the 4096x4096 original,
resampled to 2048x2048 and encoded as lossy WebP at quality 90.

Only one channel is read, as a height field. It is stored greyscale and at
quality 90 because the shader differentiates it: JPEG at the quality first
used here put 58% stronger gradients on the codec's 8-pixel block boundaries
than elsewhere, which the bump lighting turned into a visible grid.

Source: https://maxpacks.com/paperpack — a commercial pack, purchased by the
project author, who therefore holds a licence to use it.

**Redistribution is a separate question from use.** A purchase licence commonly
grants the right to use a texture in a work without granting the right to
republish the source file, and committing it here is republishing it. The pack's
terms on that point have not been recorded. If they turn out not to allow it,
the fix is to drop the file and restore the procedural grain that stood in for
it, which lives in this repository's history.
