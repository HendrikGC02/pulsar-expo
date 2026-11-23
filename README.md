# Pulsar Expo

**Live: https://hendrikgc02.github.io/pulsar-expo/**

An interactive pulsar exhibit in the browser: a rack of vintage instruments that shows radio data
from pulsars on a phosphor screen and lets you dedisperse it, fold it, filter out interference and
listen to it. Load the example pulsars or any SIGPROC filterbank (`.fil`) of your own; your files
are never uploaded. Built for a big screen with mouse and keyboard; Chrome or Edge recommended.
Sister app: [Pulsar Studio](https://hendrikgc02.github.io/pulsar-studio/).

## Using it

A rack of vintage instruments for a presenter-led stand. Press **Example pulsars** to load the
four examples, or **Open a folder** (Chrome / Edge; the app remembers the folder, so next time it
is one click) or **Pick files…**. Every `.fil` loads (first 2 s of each); **Add…** /
drag-and-drop adds more. Switch pulsar with the keys top right or **P**.

| Unit | What it does |
|------|--------------|
| **Receiver** | the data on a CRT (waterfall, pulse stack or average pulse), time fader, zoom knob, **Enlarge** (F / double-click) to fill the screen, Vintage/Plain switch (V), story steps 1–6 with captions |
| **Dedisperser** | DM knob, DM 0 / True DM / Sweep, S/N lamp meter, and *signal strength against DM* (a bowtie collapsed to S/N per trial DM) |
| **Integrator** | time and frequency scrunch selectors, *one flash close up* (scrunched pixels over the full-resolution trace) |
| **Interference filter** | noise level of every channel (dashed line = auto-zap threshold), click a spike or a stripe on the main plot to switch it off, Auto zap, Undo / Redo (Ctrl+Z / Ctrl+Y), Clear |
| **Audio** | Clicks, Whistle, **Sweep** (radio frequency → pitch), Melody, Static; Play (Space), Loop (follows your changes), speed, volume, output meter |

Each processing unit has a **patch cord**: plug it into *Bypass* to take that stage out of the signal
chain without losing its settings. The handle at the bottom (**D**) opens the detailed controls:
folding (period, Find period, phase bins, phase shift, turns per row), display (colour map — heat
by default, inferno, grey — brightest/floor faders, grid, blocky/smooth, dispersion curve, screen
shape Auto / 16:9 / 16:10), data (section start/length, resolution, bandpass, load) and sound detail
(pitch range, voices, Save WAV).

Keys: 1–6 story, Space play, ←/→ DM (Shift ×10), ↑/↓ zoom, `,` `.` pan, P next pulsar, F enlarge,
Esc back, D drawer, V vintage/plain, M sound mode, B bypass dedisperser, O open files.
The layout fills any window (it adapts between 16:9 monitors and 16:10 laptops). Fonts are bundled
in `fonts/` so it works offline.

## Example data

The `demo/` folder holds four short SIGPROC filterbanks (2-bit, L-band) that the app offers as
examples. Any other `.fil` you open is read straight from your disk by the browser and never leaves
your computer.

| File | Pulsar | Length | Size |
|------|--------|--------|------|
| `J0437-4715.fil` | PSR J0437−4715, the brightest millisecond pulsar | 0.98 s (whole file) | 20 MB |
| `J1909-3744_5s.fil` | PSR J1909−3744, millisecond pulsar in a binary | first 5 s | 25 MB |
| `vela_10s.fil` | Vela pulsar, PSR J0835−4510 | first 10 s | 67 MB |
| `B1919+21_10s.fil` | PSR B1919+21 (J1921+2153), CP 1919, the first pulsar discovered | first 10 s | 67 MB |

They were cut from the full recordings with `tools/make_demos.py` (copies the header and the first
N seconds of samples, updating `nsamples` if present):

```
python tools/make_demos.py --info some.fil          # header summary and duration
python tools/make_demos.py some.fil demo/out.fil 10 # first 10 s
```

To add or change an example, put the file in `demo/` and edit the list in `js/demos.js`.
GitHub refuses files over 100 MB and warns above 50 MB.

## Running it yourself

It is a static site: plain HTML, CSS and classic scripts, no build step, no server code. To run
it locally with the examples, serve the folder over http (browsers will not let a page fetch files
from `file://`):

```
python -m http.server 8000      # then open http://localhost:8000/
```

Double-clicking `index.html` works too (Chrome or Edge); only the example buttons are hidden then.
GitHub Pages serves the `main` branch root, so pushing to `main` updates the live site within a
minute or two.

## Files

```
index.html                      the app
css/rack.css                    rack styling
fonts/                          Barlow, Barlow Condensed, VT323 (SIL OFL), bundled
js/rack_controls.js             knobs, selectors, faders, switches, patch cords
js/expo.js                      the Expo UI
js/dsp_core.js  js/engine.js    filterbank reading, dedispersion, scrunching, folding,
                                bowtie, period search, RFI (runs in a Web Worker)
js/audio.js                     sonification + WAV + playback
js/app_core.js                  shared state & pipeline
js/pulsars.js   js/colormaps.js offline ATNF catalogue (all pulsars with a period), colour maps
js/demos.js     demo/           the example files
tools/                          make_demos.py, sync_core.sh
```

The processing core (`js/dsp_core.js`, `engine.js`, `app_core.js`, `audio.js`, `pulsars.js`,
`colormaps.js`, `demos.js`) is the same file in **pulsar-studio** and **pulsar-expo**. After changing
one of them, copy it to the other repo: `sh tools/sync_core.sh` does this when both repos sit side
by side.

## Processing notes

* Processing matches filview's `process_data` to ~3e-7 (bandpass weights use the mean
  over the whole loaded section, so with bandpass on, results differ from literal filview
  by up to ~1.5 % of peak).
* Folded views always use the loaded time resolution. Long loads are pre-averaged, so for
  millisecond pulsars load short sections at ×1.
* The offline catalogue: `PULSARS` in `js/pulsars.js` holds hand-picked entries with nicknames
  (used by the Expo); `ALL` is every ATNF pulsar with a period, regenerated with psrqpy
  (`QueryATNF(params=['JNAME','BNAME','P0','P1','PEPOCH','DM','RAJ','DECJ','DIST','AGE'])`).
  For a pulsar the catalogue lacks, typing the period in the Studio is enough: it is saved per file.
* DM search: with a period, every channel is folded once and each DM trial only rotates the
  channel profiles (like psrchive's `pdmp`), so thousands of trials take about a second.
