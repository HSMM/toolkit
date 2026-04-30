const DTMF_FREQ: Record<string, [number, number]> = {
  "1": [697, 1209],
  "2": [697, 1336],
  "3": [697, 1477],
  "4": [770, 1209],
  "5": [770, 1336],
  "6": [770, 1477],
  "7": [852, 1209],
  "8": [852, 1336],
  "9": [852, 1477],
  "*": [941, 1209],
  "0": [941, 1336],
  "#": [941, 1477],
};

let ctx: AudioContext | null = null;
let ringtoneAudio: HTMLAudioElement | null = null;
let muteAudio: HTMLAudioElement | null = null;
let outgoingRingbackTimer: number | null = null;
let outgoingRingbackGain: GainNode | null = null;

const RINGTONE_URL = "/audio/universfield-ringtone-090-496416.mp3";
const MUTE_TOGGLE_URL = "/audio/discordmute_IZNcLx2.mp3";

function audioContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const AudioCtor = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtor) return null;
  ctx ??= new AudioCtor();
  if (ctx.state === "suspended") void ctx.resume();
  return ctx;
}

export function unlockSoftphoneAudio() {
  const ac = audioContext();
  if (!ac) return;
  const gain = ac.createGain();
  gain.gain.value = 0;
  gain.connect(ac.destination);
  const osc = ac.createOscillator();
  osc.connect(gain);
  osc.start();
  osc.stop(ac.currentTime + 0.01);
}

export function playDtmfTone(digit: string, durationMs = 95) {
  const pair = DTMF_FREQ[digit];
  const ac = audioContext();
  if (!pair || !ac) return;

  const gain = ac.createGain();
  gain.gain.setValueAtTime(0.0001, ac.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.09, ac.currentTime + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + durationMs / 1000);
  gain.connect(ac.destination);

  for (const freq of pair) {
    const osc = ac.createOscillator();
    osc.type = "sine";
    osc.frequency.value = freq;
    osc.connect(gain);
    osc.start();
    osc.stop(ac.currentTime + durationMs / 1000 + 0.02);
  }
}

export function startRingtone() {
  if (ringtoneAudio && !ringtoneAudio.paused) return;
  ringtoneAudio ??= new Audio(RINGTONE_URL);
  ringtoneAudio.loop = true;
  ringtoneAudio.volume = 0.72;
  ringtoneAudio.currentTime = 0;
  void ringtoneAudio.play().catch(() => {
    // Browser autoplay policy may block ringtone until the user interacts.
  });
}

export function stopRingtone() {
  if (!ringtoneAudio) return;
  ringtoneAudio.pause();
  try {
    ringtoneAudio.currentTime = 0;
  } catch {
    // Some browsers may reject seeking while metadata is not loaded.
  }
}

export function playMuteToggleSound() {
  muteAudio ??= new Audio(MUTE_TOGGLE_URL);
  muteAudio.volume = 0.75;
  try {
    muteAudio.currentTime = 0;
  } catch {
    // Some browsers may reject seeking while metadata is not loaded.
  }
  void muteAudio.play().catch(() => {
    // Browser autoplay policy may block audio until the user interacts.
  });
}

export function startOutgoingRingback() {
  if (outgoingRingbackTimer !== null) return;
  const ac = audioContext();
  if (!ac) return;

  const playPulse = () => {
    if (!ctx) return;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    outgoingRingbackGain = gain;

    osc.type = "sine";
    osc.frequency.setValueAtTime(425, ctx.currentTime);
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.07, ctx.currentTime + 0.04);
    gain.gain.setValueAtTime(0.07, ctx.currentTime + 0.96);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 1.0);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 1.04);
  };

  playPulse();
  outgoingRingbackTimer = window.setInterval(playPulse, 4000);
}

export function stopOutgoingRingback() {
  if (outgoingRingbackTimer !== null) {
    window.clearInterval(outgoingRingbackTimer);
    outgoingRingbackTimer = null;
  }
  if (outgoingRingbackGain) {
    try {
      outgoingRingbackGain.gain.cancelScheduledValues(ctx?.currentTime ?? 0);
      outgoingRingbackGain.gain.setValueAtTime(0.0001, ctx?.currentTime ?? 0);
    } catch {
      // The node may already be stopped by its oscillator.
    }
    outgoingRingbackGain = null;
  }
}

export function playAnsweredBeep() {
  const ac = audioContext();
  if (!ac) return;

  const playBeep = (freq: number, startAt: number, duration: number) => {
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(freq, startAt);
    gain.gain.setValueAtTime(0.0001, startAt);
    gain.gain.exponentialRampToValueAtTime(0.16, startAt + 0.01);
    gain.gain.setValueAtTime(0.16, startAt + duration - 0.03);
    gain.gain.exponentialRampToValueAtTime(0.0001, startAt + duration);
    osc.connect(gain);
    gain.connect(ac.destination);
    osc.start(startAt);
    osc.stop(startAt + duration + 0.02);
  };

  const now = ac.currentTime;
  playBeep(880, now, 0.12);
  playBeep(1100, now + 0.15, 0.12);
  playBeep(1320, now + 0.30, 0.20);
}

declare global {
  interface Window {
    webkitAudioContext?: typeof AudioContext;
  }
}
