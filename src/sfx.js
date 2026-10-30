// Every sound is synthesized with Web Audio, so there are no files to load.
export function makeSfx(isOn, STEP) {
  let ctx = null, out = null, noise = null;
  const on = isOn;
  const midi = n => 440 * Math.pow(2, (n - 69) / 12);
  const PENTA = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21, 24, 26, 28];
  function wake() {
    if (!on()) return null;
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      try { ctx = new AC(); } catch (e) { return null; }
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -20; comp.knee.value = 12; comp.ratio.value = 3.5; comp.attack.value = .004; comp.release.value = .2;
      out = ctx.createGain(); out.gain.value = .6;
      out.connect(comp); comp.connect(ctx.destination);
      noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      const d = noise.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    return ctx;
  }
  function tone(f, at, dur, o = {}) {
    const t = ctx.currentTime + at;
    const osc = ctx.createOscillator(), g = ctx.createGain();
    osc.type = o.type || 'sine';
    osc.frequency.setValueAtTime(f, t);
    if (o.to) osc.frequency.exponentialRampToValueAtTime(o.to, t + (o.glide || dur));
    const peak = o.gain ?? .2, a = o.attack ?? .004;
    g.gain.setValueAtTime(.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + a);
    g.gain.exponentialRampToValueAtTime(.0001, t + dur);
    let node = osc;
    if (o.lp) { const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = o.lp; node.connect(lp); node = lp; }
    node.connect(g); g.connect(out);
    osc.start(t); osc.stop(t + dur + .03);
  }
  function hiss(at, dur, o = {}) {
    const t = ctx.currentTime + at;
    const src = ctx.createBufferSource(); src.buffer = noise; src.loop = true;
    const f = ctx.createBiquadFilter(); f.type = o.type || 'bandpass'; f.Q.value = o.q ?? 1.2;
    f.frequency.setValueAtTime(o.from || 800, t);
    if (o.to) f.frequency.exponentialRampToValueAtTime(o.to, t + dur);
    const g = ctx.createGain(), peak = o.gain ?? .15;
    g.gain.setValueAtTime(.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + (o.attack ?? dur * .35));
    g.gain.exponentialRampToValueAtTime(.0001, t + dur);
    src.connect(f); f.connect(g); g.connect(out);
    src.start(t, Math.random() * .5); src.stop(t + dur + .03);
  }
  const pluck = (n, at, gain = .16, len = .35) => { const f = midi(n); tone(f, at, len, { type: 'triangle', gain }); tone(f * 2, at, len * .55, { gain: gain * .35 }); };
  const bell = (n, at, gain = .12, len = 1.1) => { const f = midi(n); tone(f, at, len, { gain }); tone(f * 2.01, at, len * .5, { gain: gain * .4 }); tone(f * 3.98, at, len * .25, { gain: gain * .15 }); };
  const SOUNDS = {
    // a soft wooden tock, pitched a little differently per player
    key(p = 0) { const f = 330 + p * 28 + Math.random() * 20; tone(f, 0, .08, { to: f * .62, glide: .05, gain: .12 }); hiss(0, .025, { from: 2400, q: .8, gain: .025, attack: .002 }); },
    del() { tone(250, 0, .08, { to: 180, gain: .09 }); },
    tick() { tone(1600, 0, .03, { gain: .02 }); },
    // one rising pentatonic note per letter, in the region's key
    solve(root, n, at = 0) { const steps = Math.max(3, n); for (let i = 0; i < steps; i++) pluck(root + 12 + PENTA[Math.min(i, PENTA.length - 1)], at + i * STEP / 1000, .12, .32); },
    coin(at = 0) { tone(midi(83), at, .09, { type: 'square', gain: .04, lp: 3200 }); tone(midi(88), at + .08, .4, { type: 'square', gain: .04, lp: 3200 }); },
    wrong(at = 0) { tone(311, at, .16, { type: 'triangle', gain: .13 }); tone(233, at + .13, .32, { type: 'triangle', gain: .13, to: 205 }); hiss(at, .2, { from: 300, q: .7, gain: .025 }); },
    group(root, at = 0) { [0, 4, 7, 12].forEach((s, i) => pluck(root + 12 + s, at + i * .09, .13, .5)); bell(root + 24, at + .42, .06, 1.2); },
    clear(root, at = 0) { [0, 4, 7, 12, 16].forEach((s, i) => pluck(root + s, at + i * .07, .13, .7)); bell(root + 24, at + .38, .07, 1.6); },
    fog(at = 0) { hiss(at, 1.3, { from: 260, to: 3200, q: .9, gain: .11 }); [0, 4, 7, 11, 14].forEach((s, i) => bell(84 + s, at + .25 + i * .09, .03, .9)); },
    unlock(root, at = 0) { hiss(at, .05, { from: 3000, q: 2, gain: .05, attack: .003 }); tone(140, at, .1, { gain: .11, to: 90 }); bell(root + 19, at + .12, .09, 1.2); bell(root + 24, at + .26, .09, 1.4); },
    locked() { tone(150, 0, .16, { gain: .14, to: 95 }); hiss(0, .08, { type: 'lowpass', from: 500, gain: .04, attack: .003 }); },
    spend(whole, at = 0) { (whole ? [93, 88, 84, 81, 76] : [88, 84]).forEach((n, i) => tone(midi(n), at + i * .05, .16, { type: 'square', gain: .028, lp: 2800 })); bell(91, at + .12, .04, .8); },
    fanfare(at = 0) { [67, 72, 76, 79].forEach((n, i) => pluck(n, at + i * .1, .12, .4)); [72, 76, 79, 84].forEach(n => tone(midi(n), at + .42, 1.2, { type: 'triangle', gain: .045 })); },
    win(at = 0) { const mel = [72, 74, 76, 79, 76, 79, 84]; mel.forEach((n, i) => pluck(n, at + i * .13, .13, .45)); const e = at + mel.length * .13; [60, 64, 67, 72].forEach(n => tone(midi(n), e, 2.2, { type: 'triangle', gain: .055 })); bell(96, e, .05, 2); },
  };
  return {
    play(name, ...args) { if (!wake()) return; try { SOUNDS[name](...args); } catch (e) { console.error('sound', name, e); } },
    wake,
    mute() { if (ctx && ctx.state === 'running') ctx.suspend().catch(() => {}); },
  };
}
