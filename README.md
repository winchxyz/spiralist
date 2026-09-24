<p align="center">
  <a href="https://winchxyz.github.io/spiralist/">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="docs/banner-dark.png">
      <img src="docs/banner-light.png" alt="Spiralist. Any photo. One line." width="100%">
    </picture>
  </a>
</p>

<p align="center">
  <b>Spiralist redraws any photo as one continuous line, in pen, pencil, ink or paint on paper that looks real.<br>
  Then it films the line being drawn.</b>
</p>

<p align="center">
  <a href="https://winchxyz.github.io/spiralist/"><img alt="Open the live site" src="https://img.shields.io/badge/Open_the_live_site-c2410c?style=for-the-badge"></a>
  <a href="https://github.com/winchxyz/spiralist/stargazers"><img alt="Star on GitHub" src="https://img.shields.io/github/stars/winchxyz/spiralist?style=for-the-badge&logo=github&label=Star&color=1d1b18"></a>
  <a href="https://x.com/winchxyz"><img alt="@winchxyz on X" src="https://img.shields.io/badge/@winchxyz-000000?style=for-the-badge&logo=x&logoColor=white"></a>
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-6f685c?style=for-the-badge"></a>
</p>

<p align="center">
  <a href="https://winchxyz.github.io/spiralist/">
    <img src="docs/hero.gif" width="600" alt="A film made in Spiralist: a fountain pen nib starts a spiral in close-up, the camera pulls back as the portrait fills in, and the finished sheet lies on a black marble desk.">
  </a>
  <br>
  <sub>A 10-second film straight out of the app, played 1.3× faster here. Fountain pen on cream paper, Nero marble desk.</sub>
</p>

Everything runs in your browser. Your photo is never uploaded, and after the first visit the site
works offline. Line art needs one extra download the first time you use it (about 54 MB), and then
it works offline too.

## What it does

- **Three modes.** Artistic draws tone with the width of the line, Realistic draws it with how
  densely one real pen packs the line, and Line art leaves tone out and draws the contours, the way
  a person does a continuous-line drawing.
- **Four paths for the line.** Spiral, Wander, Contour and Maze. The line never lifts off the
  paper, and Wander and Maze start wherever you tap.
- **Twelve drawing media that behave like the real thing.** Fountain ink and watercolour soak into
  the paper, bleed along its fibres and dry with darker edges. Charcoal and crayon catch the
  paper's tooth. Graphite shines at a low light, and gold flashes as the light moves.
- **Realistic mode.** Four plotter styles drawn with one pen at its real width, on a sheet of a
  real size. You could draw the result by hand, and the app tells you how long it would take.
- **Line art mode.** Four one-line drawing styles, from a few bold marker lines to a brush with
  hatching. The line goes feature by feature and travels by going back over itself, like a hand
  that never lifts the pen.
- **A loupe.** Zoom in until you see the paper's fibres, with a scale bar in millimetres.
- **Cinematic films.** A macro of the nib touching the paper, a slow pull back, and the finished
  sheet on one of eight desks. Sign it with your name, then share it or post it on X.
- **Exports.** PNG up to 8K, SVG in real millimetres for pen plotters, or straight to the clipboard.
- **3D print your line.** Turn the drawing into a relief plaque or a wire sculpture, pick the
  filament colours, save a 3MF or STL for your printer, and watch the piece being printed, layer by
  layer.

## Line art

The other two modes turn light and dark into line. Line art doesn't draw tone at all. It draws the
way continuous-line artists do: only the contours that matter, one feature at a time. On a face it
starts at the brow or an eye and leaves the hair for last. To get from one feature to the next
without lifting the pen, it goes back over line it has already drawn. The line is short, sure of
itself and a little imperfect, and a nib or a brush swells where the hand slows down.

<p align="center">
  <img src="docs/lineart.gif" width="560" alt="A fountain pen nib lands on cream paper and draws a plaster bust as one line: a brow and an eye, the nose, the other eye, the jaw and neck, the lips, and the hair last. The film ends on the finished portrait lying on a black marble desk with the card '1 min 48 s of drawing in 30 s'.">
  <br>
  <sub>A 30-second Line art film in style B, straight out of the app. The nib lands at real speed, then the film<br>runs about 5× faster than the hand through the face. The GIF plays the hair 3× quicker again: 1 min 48 s of drawing by hand.</sub>
</p>

<p align="center">
  <img src="docs/lineart.jpg" alt="The four Line art styles on three sample photos, a plaster bust, a tabby cat and the full moon. A: a few bold marker lines. B: a fine fountain-pen line on cream paper. C: a grey pencil line that drifts and loops. D: a black sumi brush line on textured paper with a little hatching. Under each drawing: metres of line and the time by hand, from 43 seconds to 4 minutes 59 seconds." width="100%">
</p>

- **A Picasso: sparse.** A 1.3 mm marker and the fewest lines: a few confident contours and a lot
  of white paper. Under a minute by hand.
- **B Matisse: portrait.** A 0.55 mm fountain nib on cream paper. The features and a few lines of
  hair, in a line that swells where the hand slows. One to two minutes.
- **C Blind contour.** A soft 0.8 mm pencil, drawn as if the eyes stayed on the model and not on the
  paper: the line drifts, loops and misses a little. The slowest, three to five minutes.
- **D Brush pen + shading.** A 1.5 mm sumi brush on cold-press paper, pressed harder and lighter as
  it goes, with a few loose hatches where the subject is darkest, all in the same line. One to
  two and a half minutes.

The names describe a kind of line, not copies of anyone's drawings.

- **How it reads the photo.** A small neural network trained to make line drawings finds the lines
  worth drawing, and a face finder locates the eyes, nose and mouth so a portrait gets them.
  It reads shapes, not tones, so frame the face or subject to fill the square. Faces, animals and
  objects work best; a landscape comes out as a skyline, a tree line and a few marks. A photo with
  no clear contours gets a note saying so, not a made-up drawing.
- **Silhouette first.** Not every photo reads well as a few contours: the eye first needs the
  subject's shape. So two small segmentation models (about 9 MB of the first-use download) find
  the subject's outer shape, and that shape becomes the main line, the way a one-line artist
  starts; the features go inside it. The panel says what was found ("Subject: cat", "Scene:
  landscape").

<p align="center">
  <img src="docs/silhouettes.jpg" alt="Six test photos, a red-haired woman, a runner, a ginger cat, a horse, a cappuccino and a small car, each with its Line art drawing in style B before and after. Before, the line is a loose set of edges; after, it follows the subject's outer shape first: a head, a body, a sitting cat, a horse, a cup, a car." width="100%">
  <br>
  <sub>Style B on six photos from the test set. Before: edges only. After: the silhouette first.<br>
  Photos: CC0 from Wikimedia Commons, by
  <a href="https://commons.wikimedia.org/wiki/File:Woman_With_Red_Hair.jpg">George Hodan</a>,
  <a href="https://commons.wikimedia.org/wiki/File:Runner_437_Jonas_J%C3%B6nsson_Paddlarklubben_Delfin_in_Musselloppet_2019.jpg">W.carter</a>,
  <a href="https://commons.wikimedia.org/wiki/File:Red_tabby_sitting_on_a_cat_house.jpg">Roc0ast3r</a>,
  <a href="https://commons.wikimedia.org/wiki/File:Beautiful_Brown_Horse_(198516275).jpeg">Halyna Feshchak</a>,
  <a href="https://commons.wikimedia.org/wiki/File:Cup_of_coffee_in_Caf%C3%A9_Butter_-_Prenzlauer_Berg,_Berlin.jpg">Edward</a> and
  <a href="https://commons.wikimedia.org/wiki/File:Avenue_Roosevelt_%C3%A0_Bruxelles,_Zen_Car_en_recharge.jpg">Benoît Prieur</a>.</sub>
</p>

- **Tap the subject.** If the finder picked the wrong thing (the house, not the lighthouse), press
  **Tap the subject** and tap it on the sheet: the photo shows faintly under a dashed outline, and
  the new outline follows what is under your tap. The tap is kept with the photo, undo takes it
  back, and **Automatic** returns to the finder's choice. When a face fills the whole frame there
  is no outline to find, and the panel says so; frame the photo a little wider.
- **What it still finds hard.** Forests get a tree line with a few small spruces, thin objects
  such as a bicycle are drawn from their structure (the wheels as circles), and a pale dog keeps
  its dark eyes and nose. Still weak: long hair over the shoulders can read as a hood, and a very
  thin object is often better tapped.
- **Tools at their real widths.** Fineliner, ballpoint, fountain nib, soft pencil, sumi brush,
  marker and charcoal pencil on a 21 × 21 cm sheet, with your choice of paper and light. Sliders
  for detail, hatching and wobble.
- **Films on the hand's clock.** The pen draws in the planned order, pauses where the artist would
  look up at the model, and rides over the line where it retraces. A 30-second film shows a
  2-minute drawing about 5× faster than the hand, and a drawing shorter than the film is drawn at
  real speed.
- **Exports.** A PNG of the sheet, and an SVG with one path at the tool's real width. For the nib,
  the pencils and the brush, "Filled outline" keeps the swell of the line.
- **First use.** The line model, the face finder, the silhouette models and the runtime that runs
  them are downloaded once, the first time you open Line art: about 54 MB (66 MB in browsers that
  run it on WebGPU). The
  service worker keeps them, so Line art works offline after that. Reading a photo takes about 10
  to 30 seconds. It all runs in your browser, so the photo still never leaves your device. If the
  model can't load, a simpler edge finder reads the photo instead, the app tells you the lines
  will be rougher, and it tries the model again a little later.

## The app

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/app-desktop-dark.png">
    <img src="docs/app-desktop-light.png" alt="Spiralist on a desktop in Line art mode: a one-line fountain-pen portrait of a plaster bust on cream paper, and on the right the Artistic, Realistic and Line art switch, the four style cards A to D drawn from the same photo, and sliders for detail, hatching and wobble." width="100%">
  </picture>
</p>

<table>
  <tr>
    <td width="36%" valign="top">
      <img src="docs/app-mobile.png" alt="Spiralist on a phone in Realistic mode: a squiggle spiral portrait with a 5 cm scale bar, the caption '21 × 21 cm · 0.4 mm fineliner · ~58 min by hand', the note 'Plotter styles: one real pen, and the tone comes only from how densely the line packs', and the style cards below." width="100%">
      <br><sub>On a phone, in Realistic mode.</sub>
    </td>
    <td width="64%" valign="top">
      <img src="docs/loupe.jpg" alt="The loupe at 9×: fountain pen ink on textured cream paper, darker where it pooled, with a 2 mm scale bar." width="100%">
      <br><sub>The loupe at 9×. Fountain ink sitting in the paper's tooth; the bar is 2 mm.</sub>
    </td>
  </tr>
</table>

## Twelve media

Each tool has its own inks and its own way of meeting the paper. The same photo and the same spiral
look completely different in each one.

<p align="center">
  <img src="docs/media.jpg" alt="A grid of twelve spiral portraits of the same bust: fineliner, pencil, fountain pen, ballpoint, wax crayon, marker, sumi brush, watercolour, charcoal, chalk, neon and gold, each on its own paper." width="100%">
</p>

- **Wet media** (fountain pen, watercolour, sumi brush, marker) run on a small fluid simulation on
  the paper: water and pigment spread, wick along the fibres, pool where the pen slows down and dry
  with darker rims. Very wet paper buckles a little.
- **Dry media** (pencil, charcoal, crayon, chalk) are shaped by the paper's surface: they only
  touch the high points of the grain, so the valleys stay pale.
- **Papers**: sketchbook, cream, cold-press watercolour, kraft, black card, chalkboard and
  blueprint. The grain in the preview matches the grain in a 4K print.

## Realistic mode: plotter styles

The Artistic mode makes the line thicker where the photo is dark. Realistic mode doesn't: it gives
you **one pen at its real width** and a **sheet of a real size**, and the only way to make a dark
area is to draw more line there. Its four styles come from pen-plotter and computational drawing,
where tone comes only from how densely the line packs. A patient person could draw them by hand,
and the app tells you how long that would take.

<p align="center">
  <img src="docs/realistic.gif" width="600" alt="A stipple tour being drawn with a 0.4 mm fineliner: the pen travels region by region around the face in its real order while a counter in the corner reads the hours of drawing, ending on '2 h 36 min of drawing in 10 s'.">
  <br>
  <sub>The pen follows the real line in its real order, and the counter shows the time a hand would need.<br>A flat film on Nero marble; the GIF skips its first three seconds, where the pen lands at real speed.</sub>
</p>

<p align="center">
  <img src="docs/realistic.jpg" alt="The four Realistic plotter styles with a 0.4 mm fineliner on a 21 cm sheet, each with the tradition it comes from: A Squiggle spiral (58 min by hand), B Stipple tour (2 h 36 min), C Circle scribble (25 min) and D Flow engraving (23 min)." width="100%">
</p>

- **Four styles, each from a real tradition**:
  - **A Squiggle spiral**: the pen-plotter squiggle, like Tyler Foust's hand-drawn squiggle
    portraits. One spiral from the centre that zigzags tighter where the photo is dark.
  - **B Stipple tour**: TSP art (Kaplan & Bosch, 2005). One travelling-salesman tour through
    thousands of stipple dots, packed where it is dark.
  - **C Circle scribble**: circular scribble art. Circling loops that pile up in the shadows.
  - **D Flow engraving**: banknote-style engraving lines, joined into one. Long parallel strokes
    that bend over the form.
- **Real tool sizes**: fineliners from 0.3 to 0.8 mm, ballpoint, fountain pen, pencil, gold paint
  pen, marker, sumi and watercolour brushes, a 4 mm charcoal stick, wax crayon and 5 mm chalk.
- **Sheets that fit the tool.** A 4 mm charcoal stick can't draw a face on A4, so the app picks a
  sheet big enough, up to 2 m across. You can also pick one yourself.
- **Honest numbers**: metres of line and hours by hand for every drawing, plus Window, Raking and
  Overhead light.
- **Never cut short.** A fine pen on a big sheet can need more line than one drawing holds
  (1.4 million points). The line is then drawn with fewer points where it runs straight. If that
  is still not enough, the drawing gets less detail (fewer rings, dots or bands, bigger loops, or
  a Masterpiece drawn as Detailed), and the app tells you. How much line a sheet needs depends on
  the photo: a very dark one can lower detail even on a sheet the tool is offered, and the sheet
  list marks those sizes ("less detail with this photo"). The whole photo is always drawn.
- **The SVG is a real plotter file**: one path, the sheet's real size in millimetres, and the
  stroke as wide as the pen.

## Films

<p align="center">
  <img src="docs/desks.jpg" alt="Eight final frames from cinematic films, one per desk: Nero marble, Calacatta, Travertine, Limewash, Emerald velvet, Leather blotter, Sunlit concrete and Honey onyx, each with a different tool resting below the sheet." width="100%">
</p>

- **Cinematic or flat.** Cinematic films open on a macro of the nib, pull back with depth of field and
  a moving light, and end on the whole sheet on a desk.
- **Eight desks**: Nero marble, Calacatta, Travertine, Limewash, Emerald velvet, Leather blotter,
  Sunlit concrete and Honey onyx.
- **Sign it**: type your name or @handle and the pen signs the corner at the end, in the same ink.
- **Realistic and Line art films** show the true drawing, sped up: the pen moves at a believable
  hand speed with a clock in the corner, and nothing is faded in or revealed. In Line art the pen
  also pauses where the artist looks up at the model, and the film never runs slower than the hand.
- 9:16, 4:5, 1:1 or 16:9, 10 to 60 seconds (15, 30 or 60 in Line art), 30 or 60 fps, saved as an
  H.264 MP4. On a phone you can
  share it straight to your apps. **Post on X** shares the video on phones, and on desktop it opens a
  post and saves the video for you to attach.

Full-quality MP4s of the films above are on the [Releases page](https://github.com/winchxyz/spiralist/releases).

## 3D print your line

**3D print** (next to Download, in the menu on a phone, or press **P**) turns the drawing into a
file for a 3D printer: a relief plaque or a wire sculpture. The app offers a product only where it
prints well for that drawing. Where it doesn't, the card says why and points to the one that does.

<p align="center">
  <img src="docs/print3d.jpg" alt="The two 3D print products, rendered in the app on a desk. A: a relief plaque, a black one-line portrait raised on a white plate with a black frame, and two white slotted feet. B: the same line as a black wire sculpture standing in a small black stand." width="100%">
  <br>
  <sub>Renders from the app's own 3D preview of the Line art plaster bust.</sub>
</p>

- **A Relief plaque.** The line raised 1.2 mm on a 2.4 mm plate (plate Z 0-2.4, line Z 2.4-3.6 mm),
  in two colours, with a frame and slotted feet or hanging holes. 80 to 300 mm on its longest
  side.
- **B Wire sculpture.** The one line itself, printed flat as a single piece, with a hanging loop or
  a slotted stand. The wire is 1.6 mm wide and 2.4 mm tall, and grows to 2.4 × 3.0 mm at 300 mm so
  a big one doesn't sag.

### What prints well for which drawing

| Drawing | A Plaque | B Wire |
|---|---|---|
| Line art, and the Contour path | yes, the best pick | yes |
| Artistic Spiral, Wander, Maze | yes: a spiral is rebuilt with fewer, wider rings; Wander and Maze print as a textured relief | no: the line fuses into a disc |
| Realistic | no | no |

The Realistic plotter styles pack the line so tightly that it would print as one solid block. There
**3D print** says so and offers to switch to Line art, which prints best.

### Colours you can see

You pick the filament colour of each part from the Bambu PLA Basic or PETG Basic swatches, or any
custom colour:

- **Plaque:** Base (the background), Line (the ink) and, when it stands, the Feet. The feet match
  the plate until you give them a colour of their own.
- **Wire:** the wire and, when it stands, the Stand, which matches the wire until you give it one.

Feet or a stand in their own colour print on a second plate, so no plate needs more than one
filament change.

The preview's backdrop is Auto, Textured PEI plate, Light wood desk, Studio white or Graphite;
Auto picks one that stands out from the print. The defaults always contrast: a white plate with a
black line, and a black wire. When you pick two colours that are hard to tell apart (a black line
on a black plate, yellow on white, a dark wire on the Graphite backdrop), the dialog warns you and
offers a one-tap fix, such as "Use a white line" or a lighter plate. The 3MF and the timelapse use
the colours you chose.

### Watch it print

<p align="center">
  <img src="docs/print-timelapse.gif" width="400" alt="A print timelapse of the Line art relief plaque, with no printer in view: the white plate grows layer by layer on a plain beige floor, then the black line and frame rise on top after a filament change, while a counter reads the layer, Z and the time, ending face on at layer 18 of 18, Z 3.6 mm, 1 h 21 min.">
  <img src="docs/print-timelapse-wire.gif" width="400" alt="A print timelapse of the Line art wire sculpture: the black one-line portrait grows from the floor layer by layer, ending face on at layer 12 of 12, Z 2.4 mm, 20 min.">
  <br>
  <sub>The plaque (1 h 21 min of printing) and the wire (20 min), each in 10 s, saved from the app.</sub>
</p>

**Watch it print** shows your piece being printed, and only the piece: no printer in the way, just
the plastic growing layer by layer on a plain floor. It is sliced into 0.2 mm layers with walls
and infill, and every bead appears in your filament colours. A colour change shows at its layer,
and a counter shows the layer, Z and the time so far against the estimated total. At the end the
camera comes round to the front, so you see the finished piece face on.

It plays right in the app. Drag to turn it, scroll or pinch to zoom, double-click to reset the
view, press Space to pause and the arrow keys to step one layer. Choose how long the whole print
takes to play (15 s to 3 min) and the camera: Orbit, Front or Close-up.

Save it as an MP4 in 9:16, 1:1 or 16:9, 10, 15 or 30 seconds, at 30 or 60 fps, then Download it or
**Post on X**. You can also drop in a file you sliced yourself (G-code from Bambu Studio,
OrcaSlicer or PrusaSlicer, or a `.gcode.3mf`), and the timelapse replays that instead, on the
slicer's own clock. When the piece doesn't fit the printer, the button is off and says why.

### Files: 3MF and STL

- **3MF** for Bambu Studio and OrcaSlicer. Each part is its own object in its colour and filament
  slot, and carries its print settings: 2 walls and 15% infill for the plaque, and solid infill
  for the wire, which is only two perimeters wide. Parts that shouldn't share a plate go on a
  second one.
- **STL** saves one file per part, zipped when there are several.
- **Two colours.** With an AMS, the plaque's line is filament 2 and the plate is filament 1; check
  in your slicer that the Line part shows filament 2. With one filament, choose **Swap after
  Z 2.4 mm**: the file asks for a pause there, and everything printed above it comes out in the
  new colour.
- **Sizes** are shown per part with their axis ranges, for example Plate X 0-110.8, Y 0-150,
  Z 0-2.4 mm, and the report lists what was changed so the drawing prints (lines thickened to
  0.8 mm, gaps merged, a spiral rebuilt) and what to know before printing.
- **Grams and time** are estimates. For the A2L they came within about 5% of Bambu Studio's own
  slices on the test pieces; your slicer has the final word.

### Printers

The A2L is the default. The app warns you when a part doesn't fit the bed, and the time estimate
and the colour changes follow the printer you pick.

| Printer | Bed | Two colours by |
|---|---|---|
| Bambu Lab A1 mini | X 0-180, Y 0-180, Z 0-180 mm | AMS |
| Bambu Lab A1 | X 0-256, Y 0-256, Z 0-256 mm | AMS |
| Bambu Lab A2L | X 0-330, Y 0-320, Z 0-325 mm | AMS |
| Bambu Lab P1S | X 0-256, Y 0-256, Z 0-256 mm | AMS |
| Bambu Lab X1C | X 0-256, Y 0-256, Z 0-256 mm | AMS |
| Prusa MK4 | X 0-250, Y 0-210, Z 0-220 mm | filament swap |
| Prusa MINI+ | X 0-180, Y 0-180, Z 0-180 mm | filament swap |
| Creality Ender-3 | X 0-220, Y 0-220, Z 0-250 mm | filament swap |
| Generic 220 × 220 | X 0-220, Y 0-220, Z 0-250 mm | filament swap |

All with a 0.4 mm nozzle, in PETG Basic or PLA Basic.

## How it works

1. **Photo to tone.** The photo is turned into a map of light and dark, with automatic levels
   so the face reads well. You can crop, rotate and adjust it.
2. **Tone to one line.** A path generator walks that map and lays down a single line. The
   spiral widens in the dark areas. The Realistic styles keep the width fixed and pack the line
   tighter instead: denser zigzags, a closer tour, more loops or more engraved lines.
3. **Line to marks on paper.** The line is drawn with WebGL 2 as a physical mark: the paper has a
   height map and fibres, each medium has its own rules for how it meets them, and wet media run a
   small simulation of water and pigment on a grid over the sheet.
4. **Marks to film.** A film is rendered frame by frame, not recorded from the screen. A virtual
   camera and light move over the desk, and the frames are encoded to MP4 in the browser.

In Realistic mode, each style also works out how fast a hand would move along its line (slower in
tight curves and dense patches). That clock drives the playback, the film's counter and the
"by hand" estimate.

Line art takes a different road from step 1:

1. **Photo to lines.** A small neural network trained to make line drawings (Informative
   Drawings) turns the photo into a line drawing, and MediaPipe's Face Landmarker finds the eyes,
   brows, nose and mouth. The model runs in a Web Worker with onnxruntime-web, and the face finder
   runs on the page; both run on your device.
2. **Lines to strokes.** The drawing is traced into strokes, and each stroke is tagged with the
   feature it belongs to (brow, eye, nose, lips, jaw, ear, hair or outline) where the face
   landmarks say so.
3. **Strokes to one line.** Each style picks the strokes it wants and plans an order, feature by
   feature. The pen gets from one stroke to the next by going back over drawn line where it can,
   and by a short link where it can't. The hand gets a clock, slower in curves and with a short
   look at the model before each new feature, and nibs and brushes get their pressure from it.

That clock drives the playback, the film and the "by hand" time, just as in Realistic mode.

## Run locally

It's a static site with no build step and no dependencies to install:

```bash
git clone https://github.com/winchxyz/spiralist.git
cd spiralist
node dev-server.js 8830
```

Then open <http://localhost:8830>. You need a browser with WebGL 2 (current Chrome, Edge, Safari
or Firefox). Films use WebCodecs where the browser has it and fall back to MediaRecorder.

### Keyboard

| Key | Does |
|---|---|
| `M` | next mode: Artistic, Realistic, Line art |
| `1`–`9` | pick a look (Artistic) |
| `1`–`4` | pick style A–D (Realistic and Line art) |
| `[` `]` | fewer or more rings (Artistic), less or more detail (Realistic and Line art) |

## Tech

- Vanilla JavaScript ES modules. No framework, no bundler, no build step.
- WebGL 2 for the drawing, the paper and the wet-media simulation; Web Workers build the
  Realistic and Line art lines.
- Line art runs a line-drawing model with onnxruntime-web (WebGPU where the device has it,
  otherwise WebAssembly) and MediaPipe's Face Landmarker. Both are vendored in `vendor/` and load
  only when Line art is first used; the service worker keeps them in their own cache.
- WebCodecs and a vendored MP4 muxer for the films.
- Runs entirely in the browser, and a service worker keeps it working offline. The photo never
  leaves your device.

### Code map

| Path | What |
|---|---|
| `js/tone.js` | photo → tone map (levels, detail, auto midtones) |
| `js/spiral.js`, `js/freeline.js`, `js/maze.js` | tone → one line: spiral, wander and contour, maze |
| `js/lineart/` | Line art mode: the four styles (`styles.js`), the engine and its cache (`index.js`), reading the photo with the model and the face finder (`lines.js`, `worker.js`), tracing strokes (`strokes.js`), and planning the one line and the hand's clock (`path.js`, `buildworker.js`) |
| `js/real/` | Realistic mode: the four styles (`squiggle`, `stipple`, `scribble`, `engrave`), sheet sizes and hand time (`index.js`), and the worker that builds them (`builder.js`, `worker.js`) |
| `js/renderer.js`, `js/shaders.js`, `js/brushes.js`, `js/papers.js` | the WebGL 2 renderer, the media and the papers |
| `js/wetsim.js` | the wet media simulation (water, pigment, fibres, buckling) |
| `js/loupe.js` | the zoom loupe |
| `js/film.js`, `js/scene.js`, `js/desks.js`, `js/signature.js`, `js/encoder.js` | film timeline, camera and desks, signature, video encoding |
| `js/export.js`, `js/download.js`, `js/share.js` | PNG and SVG export, sharing to X |
| `js/materials.js` | looks, and the Realistic and Line art tools at their real sizes |
| `js/print3d/` | 3D printing: the dialog (`dialog.js`), printers, filaments and colour checks (`presets.js`), the products and their meshes (`products.js`, `pkit.js`, `mesh.js`, `worker.js`), the 3D preview (`view.js`), and the print timelapse: slicing, film and G-code replay (`toolpath.js`, `toolpath.worker.js`, `printfilm.js`, `gcode.js`) |
| `vendor/` | the MP4 muxer, and the Line art model, face finder and runtime (sources, sizes and licences in [`vendor/LICENSES.md`](vendor/LICENSES.md)) |
| `js/app.js` | the app itself |
| `js/tools.js`, `js/samples.js` | pen sprites and the built-in sample photos |
| `dev/`, `tests/` | visual labs and tests |

### Tests

```bash
node tests/geometry.test.mjs
node tests/brush.test.mjs
node tests/papers.test.mjs
node tests/scene.test.mjs
node tests/export.test.mjs
node tests/real.test.mjs
node tests/print3d.test.mjs
node tests/print3d_presets.test.mjs
node tests/print3d_film.test.mjs
```

The browser tests (`tests/intake.e2e.mjs`, `tests/film.e2e.mjs`, `tests/film.dialog.e2e.mjs`,
`tests/film.lineart.mjs`, `tests/real.e2e.mjs`, `tests/loupe.e2e.mjs`, `tests/app-shot.mjs`,
`tests/lineart.subject.e2e.mjs`, `tests/print3d_dialog.mjs`, `tests/print3d_film.e2e.mjs`) drive
the running dev server with Playwright. `tests/print3d_slice.mjs` and `tests/print3d_plates.mjs`
slice exported 3MFs with the Bambu Studio command line. `tests/print3d_offline.e2e.mjs` starts its own server on
127.0.0.1 (the only local host where the service worker registers), stops it, and checks that the
print timelapse still opens offline. The visual labs live in `dev/`, including the Line art
line-up (`dev/lineart_lineup.html`).

## Credits

Made by [@winchxyz](https://x.com/winchxyz) with [Claude Code](https://claude.com/claude-code).

Line art stands on other people's work:

- **Informative Drawings**, the line-drawing model: Caroline Chan, Frédo Durand and Phillip Isola,
  "Learning to generate line drawings that convey geometry and semantics", CVPR 2022
  ([code and weights](https://github.com/carolineec/informative-drawings), MIT). The ONNX
  conversion is by Joseph Rocca ([image-to-line-art-js](https://github.com/josephrocca/image-to-line-art-js), MIT).
- **MediaPipe Face Landmarker** by Google
  ([docs](https://ai.google.dev/edge/mediapipe/solutions/vision/face_landmarker), Apache-2.0).
- **DeepLab-v3** and **MagicTouch** (MediaPipe image and interactive segmenters) by Google, for the
  silhouettes ([docs](https://ai.google.dev/edge/mediapipe/solutions/vision/image_segmenter), Apache-2.0).
- **ONNX Runtime Web** by Microsoft ([onnxruntime](https://github.com/microsoft/onnxruntime), MIT).

The Realistic styles follow pen-plotter and computational drawing traditions: Tyler Foust's
squiggle portraits, TSP art (Craig S. Kaplan and Robert Bosch, "TSP Art", Bridges 2005), circular
scribble art and banknote engraving.

## License

MIT, see [LICENSE](LICENSE). `vendor/mp4-muxer.mjs` is © Vanilagy (MIT). The Line art model,
MediaPipe and onnxruntime-web files in `vendor/` keep their own licences (MIT and Apache-2.0),
listed with their sources in [`vendor/LICENSES.md`](vendor/LICENSES.md).
