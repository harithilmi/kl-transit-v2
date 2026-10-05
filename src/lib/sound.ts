// Sound: tiny synthesized cues on deliberate taps only (never hover)

let ctx: AudioContext | null = null;
let on = localStorage.getItem('sound') !== 'off';

/** One soft blip: quick attack, exponential decay. Sine by default; square is the 8-bit game sound */
function blip(freq: number, at: number, dur: number, gain = 0.05, endFreq = freq, type: OscillatorType = 'sine') {
  if (!ctx) return;
  const t = ctx.currentTime + at, o = ctx.createOscillator(), g = ctx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  o.frequency.exponentialRampToValueAtTime(endFreq, t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(ctx.destination);
  o.start(t);
  o.stop(t + dur + 0.02);
}

const cues = {
  bus: () => { blip(880, 0, 0.09); blip(1320, 0.05, 0.12, 0.035); },
  stop: () => { blip(660, 0, 0.09); blip(990, 0.05, 0.12, 0.035); },
  close: () => blip(620, 0, 0.1, 0.04, 440),
  tick: () => blip(1400, 0, 0.04, 0.025),
  city: () => { blip(523, 0, 0.12, 0.04); blip(784, 0.08, 0.16, 0.04); },
  // Flyover, 8-bit style: a coin at each stop (B5 flicks up to a ringing E6); a 1-up run where you change to rail
  arrive: () => { blip(988, 0, 0.08, 0.025, 988, 'square'); blip(1319, 0.08, 0.45, 0.025, 1319, 'square'); },
  transfer: () => [659, 784, 1319, 1047, 1175, 1568].forEach((f, i) => blip(f, i * 0.11, i < 5 ? 0.11 : 0.3, 0.025, f, 'square')),
};
export type Cue = keyof typeof cues;

export const sound = {
  get on() { return on; },
  toggle() {
    on = !on;
    localStorage.setItem('sound', on ? 'on' : 'off');
    if (on) sound.play('tick');
    return on;
  },
  play(cue: Cue) {
    if (!on) return;
    ctx ??= new AudioContext();
    if (ctx.state === 'suspended') ctx.resume();
    cues[cue]();
  },
};
