/* Waverunner core: turns a GPS track into wavetable frames in the browser.
   A line-for-line port of run_wavetables.py and make_explorer_data.py from the
   Strava-API repo, so a GPX file dropped on the page gives the same frames as
   the Python scripts. Nothing here touches the network: files stay on the device. */
(function (root) {
  "use strict";

  const FRAME = 2048;      // samples per wavetable frame
  const NUM_KEYS = 16;     // keyframes in progress mode
  const NUM_FRAMES = 256;  // frames in a finished wavetable
  const WINDOW = 0.12;     // stretch length as a fraction of the route
  const MAP_POINTS = 400;
  const INGREDIENT_POINTS = 90;
  const PREVIEW = 512;     // samples per frame drawn and played on the page

  // ---- numpy helpers -------------------------------------------------------
  function linspace(a, b, n) {
    const out = new Float64Array(n);
    if (n === 1) { out[0] = a; return out; }
    const step = (b - a) / (n - 1);
    for (let i = 0; i < n; i++) out[i] = a + i * step;
    out[n - 1] = b;
    return out;
  }

  // np.interp for increasing xp
  function interp(x, xp, fp) {
    const out = new Float64Array(x.length);
    let j = 0;
    const last = xp.length - 1;
    for (let i = 0; i < x.length; i++) {
      const v = x[i];
      if (v <= xp[0]) { out[i] = fp[0]; continue; }
      if (v >= xp[last]) { out[i] = fp[last]; continue; }
      while (j < last - 1 && xp[j + 1] < v) j++;
      while (j > 0 && xp[j] > v) j--;
      const t = (v - xp[j]) / (xp[j + 1] - xp[j]);
      out[i] = fp[j] + t * (fp[j + 1] - fp[j]);
    }
    return out;
  }

  function gradient(f) {
    const n = f.length, out = new Float64Array(n);
    if (n < 2) return out;
    out[0] = f[1] - f[0];
    out[n - 1] = f[n - 1] - f[n - 2];
    for (let i = 1; i < n - 1; i++) out[i] = (f[i + 1] - f[i - 1]) / 2;
    return out;
  }

  function unwrap(p) {
    const n = p.length, out = new Float64Array(n);
    if (!n) return out;
    out[0] = p[0];
    let corr = 0;
    const TAU = 2 * Math.PI;
    for (let i = 1; i < n; i++) {
      const d = p[i] - p[i - 1];
      let dd = ((d + Math.PI) % TAU + TAU) % TAU - Math.PI;
      if (dd === -Math.PI && d > 0) dd = Math.PI;
      if (Math.abs(d) >= Math.PI) corr += dd - d;
      out[i] = p[i] + corr;
    }
    return out;
  }

  // _smooth: moving average with edge padding (same result as the numpy version)
  function smooth(v, width) {
    if (width < 2) return v;
    const n = v.length, h = Math.floor(width / 2), out = new Float64Array(n);
    const at = (j) => v[Math.min(Math.max(j - h, 0), n - 1)];
    let sum = 0;
    for (let j = 0; j < width; j++) sum += at(j);
    out[0] = sum / width;
    for (let r = 1; r < n; r++) { sum += at(r + width - 1) - at(r - 1); out[r] = sum / width; }
    return out;
  }

  function detrend(v) {
    const n = v.length, out = new Float64Array(n), a = v[0], b = v[n - 1];
    for (let i = 0; i < n; i++) out[i] = v[i] - (n > 1 ? a + (b - a) * i / (n - 1) : a);
    return out;
  }

  const maxAbs = (v) => { let m = 0; for (let i = 0; i < v.length; i++) { const a = Math.abs(v[i]); if (a > m) m = a; } return m; };

  // Stretch/compress a stream to n samples, centre it on 0 and peak-normalise to +/-1.
  function wavTransform(arr, n = FRAME) {
    const src = Float64Array.from(arr);
    const idx = new Float64Array(src.length);
    for (let i = 0; i < src.length; i++) idx[i] = i;
    const out = interp(linspace(0, src.length - 1, n), idx, src);
    let mean = 0;
    for (let i = 0; i < n; i++) mean += out[i];
    mean /= n;
    for (let i = 0; i < n; i++) out[i] -= mean;
    const peak = maxAbs(out);
    if (peak > 0) for (let i = 0; i < n; i++) out[i] /= peak;
    return out;
  }

  function toMetres(lat, lng) {
    let mean = 0;
    for (let i = 0; i < lat.length; i++) mean += lat[i];
    mean /= lat.length;
    const k = 111320 * Math.cos(mean * Math.PI / 180);
    const x = new Float64Array(lat.length), y = new Float64Array(lat.length);
    for (let i = 0; i < lat.length; i++) { x[i] = (lng[i] - lng[0]) * k; y[i] = (lat[i] - lat[0]) * 110540; }
    return { x, y };
  }

  // ---- the route, resampled every ~2 m ---------------------------------------
  function resample(lat, lng, alt) {
    const { x, y } = toMetres(lat, lng);
    const D = [0], X = [x[0]], Y = [y[0]], A = [alt[0]];
    let total = 0;
    for (let i = 1; i < x.length; i++) {
      const d = Math.hypot(x[i] - x[i - 1], y[i] - y[i - 1]);
      total += d;
      if (d > 0) { D.push(total); X.push(x[i]); Y.push(y[i]); A.push(alt[i]); }  // drop stationary duplicates
    }
    if (D.length < 2 || total < 50) throw new Error("This track is too short (under 50 m) to make a wavetable.");
    const n = Math.max(Math.floor(total / 2.0), NUM_KEYS * 64);
    const u = linspace(0, total, n);
    const RX = interp(u, D, X), RY = interp(u, D, Y), RA = interp(u, D, A);
    const gx = gradient(RX), gy = gradient(RY), raw = new Float64Array(n);
    for (let i = 0; i < n; i++) raw[i] = Math.atan2(gy[i], gx[i]);
    const heading = smooth(unwrap(raw), Math.floor(20 / (total / n)));  // ~20 m, so GPS jitter isn't a corner
    return { n, u, X: RX, Y: RY, A: RA, heading, total };
  }

  // Overlapping stretches sliding evenly from start to finish.
  function stretchBounds(n, count = NUM_KEYS, window = WINDOW) {
    const width = Math.min(Math.max(window, 1 / count), 1.0);
    return Array.from(linspace(0, 1 - width, count), (s) => [Math.floor(s * n), Math.min(Math.floor((s + width) * n), n)]);
  }

  function sideOf(X, Y, a, b) {
    const cx = X[b - 1] - X[a], cy = Y[b - 1] - Y[a];
    const chord = Math.hypot(cx, cy) || 1.0;
    const side = new Float64Array(b - a);
    for (let i = a; i < b; i++) side[i - a] = ((X[i] - X[a]) * cy - (Y[i] - Y[a]) * cx) / chord;  // signed distance from the straight line
    return side;
  }

  // _progress_keyframes: 16 full-length (2048) keyframes, each the same way up as the one before.
  function progressKeyframes(r, brightness = 0.5, elevation = 0.5) {
    const parts = stretchBounds(r.n).map(([a, b]) => [
      sideOf(r.X, r.Y, a, b), detrend(r.heading.subarray(a, b)), detrend(r.A.subarray(a, b)),
    ]);
    const scale = [0, 1, 2].map((k) => Math.max(...parts.map((p) => maxAbs(p[k]))) || 1.0);
    const keys = parts.map(([side, turn, climb]) => {
      const v = new Float64Array(side.length);
      for (let i = 0; i < v.length; i++) {
        v[i] = (1 - brightness) * side[i] / scale[0] + brightness * turn[i] / scale[1] + elevation * climb[i] / scale[2];
      }
      return wavTransform(v);
    });
    for (let k = 1; k < keys.length; k++) {
      let dot = 0;
      for (let i = 0; i < FRAME; i++) dot += keys[k][i] * keys[k - 1][i];
      if (dot < 0) for (let i = 0; i < FRAME; i++) keys[k][i] = -keys[k][i];
    }
    return keys;
  }

  // progress_frames: blend keyframes into 256 frames, each brought back to full level.
  function blendKeys(keys, numFrames = NUM_FRAMES) {
    const K = keys.length, frames = [];
    for (const p of linspace(0, K - 1, numFrames)) {
      const i = Math.min(Math.floor(p), K - 2), t = p - i, f = new Float64Array(FRAME);
      for (let j = 0; j < FRAME; j++) f[j] = (1 - t) * keys[i][j] + t * keys[i + 1][j];
      const peak = Math.max(maxAbs(f), 1e-9);
      for (let j = 0; j < FRAME; j++) f[j] /= peak;
      frames.push(f);
    }
    return frames;
  }

  // morph_frames: the original method, longitude -> elevation -> latitude (osc_gen.sig.morph).
  function morphFrames(waves, numFrames = NUM_FRAMES) {
    const gaps = waves.length - 1;
    const gap = Math.round(numFrames / gaps);
    const ranges = Array.from({ length: gaps }, (_, j) => (j === 0 ? gap : gap + 1));
    const sum = () => ranges.reduce((s, v) => s + v, 0);
    let k = ranges.length - 1;
    while (sum() < numFrames + gaps - 1) { ranges[k] += 1; k = (k - 1 + ranges.length) % ranges.length; }
    k = ranges.length - 1;
    while (sum() > numFrames + gaps - 1) { ranges[k] -= 1; k = (k - 1 + ranges.length) % ranges.length; }
    const frames = [];
    for (let g = 0; g < gaps; g++) {
      const m = ranges[g];
      for (let s = g ? 1 : 0; s < m; s++) {
        const t = s / (m - 1), f = new Float64Array(FRAME);
        for (let j = 0; j < FRAME; j++) f[j] = waves[g][j] * (1 - t) + waves[g + 1][j] * t;
        frames.push(f);
      }
    }
    return frames;
  }

  const r1 = (v) => Math.round(v * 10) / 10, r2 = (v) => Math.round(v * 100) / 100, r3 = (v) => Math.round(v * 1000) / 1000;
  const preview = (f) => { const step = f.length / PREVIEW, out = []; for (let i = 0; i < f.length; i += step) out.push(r3(f[i])); return out; };

  // explorer_run: everything the page draws for one run, plus full-length frames for downloads.
  function buildRun(track, id, label, sub) {
    const { lat, lng, alt } = track;
    const r = resample(lat, lng, alt);
    const { n, u, X, Y, A, heading, total } = r;
    const point = (i) => [r1(X[i]), r1(Y[i])];
    const route = Array.from(linspace(0, n - 1, MAP_POINTS), (i) => point(Math.floor(i)));
    const stretches = stretchBounds(n).map(([a, b]) => {
      const side = sideOf(X, Y, a, b), turn = detrend(heading.subarray(a, b));
      const k = Array.from(linspace(0, b - a - 1, INGREDIENT_POINTS), Math.floor);
      return {
        a: Math.round(a / (n - 1) * (MAP_POINTS - 1)),
        b: Math.round((b - 1) / (n - 1) * (MAP_POINTS - 1)),
        km: [r2(u[a] / 1000), r2(u[b - 1] / 1000)],
        p0: point(a), p1: point(b - 1),
        along: k.map((i) => Math.round(u[a + i] - u[a])),
        side: k.map((i) => r1(side[i])),
        turn: k.map((i) => r1(turn[i] * 180 / Math.PI)),
        elev: k.map((i) => r1(A[a + i])),
      };
    });
    const keys = progressKeyframes(r);
    const axesFull = { lon: wavTransform(lng), ele: wavTransform(alt), lat: wavTransform(lat) };
    return {
      id, day: label, where: sub, km: r2(total / 1000), route, stretches,
      keys: keys.map(preview),
      axes: { lon: preview(axesFull.lon), ele: preview(axesFull.ele), lat: preview(axesFull.lat) },
      hasEle: track.hasEle,
      full: { keys, axes: axesFull },
    };
  }

  // ---- GPX in, wavetable WAV out -------------------------------------------
  function parseGPX(text) {
    const doc = new DOMParser().parseFromString(text, "application/xml");
    if (doc.getElementsByTagName("parsererror").length) throw new Error("This file isn't valid GPX.");
    const kid = (node, name) => { const c = node.getElementsByTagNameNS("*", name)[0]; return c ? c.textContent.trim() : ""; };
    let pts = doc.getElementsByTagNameNS("*", "trkpt");
    if (!pts.length) pts = doc.getElementsByTagNameNS("*", "rtept");
    const lat = [], lng = [], alt = [];
    let hasEle = false, firstTime = "";
    for (const p of pts) {
      const la = parseFloat(p.getAttribute("lat")), lo = parseFloat(p.getAttribute("lon"));
      if (!isFinite(la) || !isFinite(lo)) continue;
      const e = parseFloat(kid(p, "ele"));
      lat.push(la); lng.push(lo);
      if (isFinite(e)) { alt.push(e); hasEle = true; } else alt.push(NaN);
      if (!firstTime) firstTime = kid(p, "time");
    }
    if (lat.length < 2) throw new Error("No track points found in this GPX file.");
    // Fill gaps in elevation from the nearest earlier reading (or 0 if the file has none).
    let last = NaN;
    for (let i = 0; i < alt.length; i++) { if (isFinite(alt[i])) last = alt[i]; else alt[i] = last; }
    const firstEle = alt.find(isFinite);
    for (let i = 0; i < alt.length; i++) if (!isFinite(alt[i])) alt[i] = isFinite(firstEle) ? firstEle : 0;
    const trk = doc.getElementsByTagNameNS("*", "trk")[0];
    const meta = doc.getElementsByTagNameNS("*", "metadata")[0];
    const name = (trk && kid(trk, "name")) || (meta && kid(meta, "name")) || "";
    return { lat, lng, alt, hasEle, name, time: firstTime || (meta ? kid(meta, "time") : "") };
  }

  // Mono 32-bit float WAV with Serum's 'clm ' chunk (Vital reads the same file).
  function wavetableWav(frames, title, samplerate = 48000) {
    const enc = new TextEncoder();
    const clm = enc.encode(`<!>${FRAME} 00000000 wavetable (www.xferrecords.com)`);
    let inam = title ? enc.encode(title) : null;
    if (inam) { const t = new Uint8Array(inam.length + 1 + ((inam.length + 1) % 2)); t.set(inam); inam = t; }
    const count = frames.length * FRAME;
    const info = inam ? 8 + 4 + 8 + inam.length : 0;
    const size = 12 + (8 + 18) + (8 + 4) + (8 + clm.length) + info + 8 + count * 4;
    const buf = new ArrayBuffer(size), dv = new DataView(buf), bytes = new Uint8Array(buf);
    let o = 0;
    const tag = (s) => { for (let i = 0; i < 4; i++) dv.setUint8(o++, s.charCodeAt(i)); };
    const u32 = (v) => { dv.setUint32(o, v, true); o += 4; };
    const u16 = (v) => { dv.setUint16(o, v, true); o += 2; };
    tag("RIFF"); u32(size - 8); tag("WAVE");
    tag("fmt "); u32(18); u16(3); u16(1); u32(samplerate); u32(samplerate * 4); u16(4); u16(32); u16(0);
    tag("fact"); u32(4); u32(count);
    tag("clm "); u32(clm.length); bytes.set(clm, o); o += clm.length;
    if (inam) { tag("LIST"); u32(4 + 8 + inam.length); tag("INFO"); tag("INAM"); u32(inam.length); bytes.set(inam, o); o += inam.length; }
    tag("data"); u32(count * 4);
    for (const f of frames) for (let j = 0; j < FRAME; j++) { dv.setFloat32(o, Math.max(-1, Math.min(1, f[j])), true); o += 4; }
    return new Blob([buf], { type: "audio/wav" });
  }

  const api = { FRAME, NUM_KEYS, NUM_FRAMES, parseGPX, buildRun, blendKeys, morphFrames, wavetableWav, wavTransform };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.WaverunnerCore = api;
})(typeof self !== "undefined" ? self : this);
