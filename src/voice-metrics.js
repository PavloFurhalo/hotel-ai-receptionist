/**
 * Per-turn voice latency tracking for Realtime + Twilio phone calls.
 */

function nowMs() {
  return Date.now();
}

function formatClock(ms) {
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms);
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  const s = String(d.getSeconds()).padStart(2, "0");
  const msPart = String(d.getMilliseconds()).padStart(3, "0");
  return `${h}:${m}:${s}.${msPart}`;
}

function delta(from, to) {
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  return Math.max(0, to - from);
}

export function createVoiceTurnTracker({ logSummary = true, logger = console } = {}) {
  let turnIndex = 0;
  let current = null;
  const completedTurns = [];

  function startTurn() {
    turnIndex += 1;
    current = {
      turn: turnIndex,
      speechStart: null,
      speechEnd: null,
      sttStart: null,
      sttEnd: null,
      llmStart: null,
      firstToken: null,
      ttsStart: null,
      firstAudioChunk: null,
      playbackStart: null,
      playbackEnd: null,
      interrupted: false,
      fallback: false,
    };
    return current;
  }

  function ensureTurn() {
    if (!current) startTurn();
    return current;
  }

  function mark(field, at = nowMs()) {
    const turn = ensureTurn();
    if (turn[field] == null) {
      turn[field] = at;
    }
    return turn;
  }

  function finalizeTurn(extra = {}) {
    if (!current) return null;

    const turn = { ...current, ...extra };
    completedTurns.push(turn);

    if (logSummary) {
      logTurnSummary(turn, logger);
    }

    current = null;
    return turn;
  }

  return {
    get currentTurn() {
      return current;
    },
    get turns() {
      return [...completedTurns];
    },
    onSpeechStart(at = nowMs()) {
      if (current?.speechEnd || current?.playbackStart) {
        finalizeTurn({ reason: "new_user_turn" });
      }
      startTurn();
      mark("speechStart", at);
    },
    onSpeechStop(at = nowMs()) {
      mark("speechEnd", at);
      mark("sttStart", at);
    },
    onSttComplete(at = nowMs()) {
      mark("sttEnd", at);
    },
    onLlmStart(at = nowMs()) {
      mark("llmStart", at);
    },
    onFirstToken(at = nowMs()) {
      mark("firstToken", at);
    },
    onTtsStart(at = nowMs()) {
      mark("ttsStart", at);
      if (current?.firstAudioChunk == null) {
        mark("playbackStart", at);
      }
    },
    onFirstAudioChunk(at = nowMs()) {
      mark("firstAudioChunk", at);
      if (current?.playbackStart == null) {
        mark("playbackStart", at);
      }
    },
    onPlaybackEnd(at = nowMs()) {
      mark("playbackEnd", at);
      return finalizeTurn({ reason: "playback_complete" });
    },
    onInterrupted(at = nowMs()) {
      if (!current) return null;
      current.interrupted = true;
      mark("playbackEnd", at);
      return finalizeTurn({ reason: "barge_in" });
    },
    onFallback(at = nowMs()) {
      if (!current) startTurn();
      current.fallback = true;
      mark("llmStart", at);
    },
    reset() {
      current = null;
      turnIndex = 0;
      completedTurns.length = 0;
    },
  };
}

export function summarizeTurnMetrics(turn) {
  if (!turn) return null;

  const responseLatencyMs = delta(turn.speechEnd, turn.firstAudioChunk);
  const sttLatencyMs = delta(turn.sttStart, turn.sttEnd);
  const llmToAudioMs = delta(turn.llmStart, turn.firstAudioChunk);

  return {
    turn: turn.turn,
    timestamps: {
      speech_start: formatClock(turn.speechStart),
      speech_end: formatClock(turn.speechEnd),
      stt_start: formatClock(turn.sttStart),
      stt_end: formatClock(turn.sttEnd),
      llm_start: formatClock(turn.llmStart),
      first_token: formatClock(turn.firstToken),
      tts_start: formatClock(turn.ttsStart),
      first_audio_chunk: formatClock(turn.firstAudioChunk),
      playback_start: formatClock(turn.playbackStart),
      playback_end: formatClock(turn.playbackEnd),
    },
    deltasMs: {
      stt: sttLatencyMs,
      llm_to_first_audio: llmToAudioMs,
      speech_end_to_first_audio: responseLatencyMs,
    },
    interrupted: Boolean(turn.interrupted),
    fallback: Boolean(turn.fallback),
    reason: turn.reason || null,
  };
}

function writeLog(logger, message) {
  try {
    if (logger && typeof logger.info === "function") {
      logger.info(message);
      return;
    }
    if (logger && typeof logger.log === "function") {
      logger.log(message);
      return;
    }
  } catch {
    // never crash the call on logging
  }
  console.log(message);
}

export function logTurnSummary(turn, logger = console) {
  const summary = summarizeTurnMetrics(turn);
  if (!summary) return;

  const lines = [
    "\nVOICE TURN LATENCY:",
    `  Turn:                 ${summary.turn}`,
  ];

  const ts = summary.timestamps;
  if (ts.speech_end) lines.push(`  User speech ended:    ${ts.speech_end}`);
  if (ts.stt_end) lines.push(`  STT completed:        ${ts.stt_end}`);
  if (ts.llm_start) lines.push(`  LLM response start:   ${ts.llm_start}`);
  if (ts.first_token) lines.push(`  LLM first token:      ${ts.first_token}`);
  if (ts.tts_start) lines.push(`  TTS started:          ${ts.tts_start}`);
  if (ts.first_audio_chunk) {
    lines.push(`  TTS first audio:      ${ts.first_audio_chunk}`);
  }
  if (ts.playback_start) lines.push(`  Playback started:     ${ts.playback_start}`);
  if (ts.playback_end) lines.push(`  Playback ended:       ${ts.playback_end}`);

  const rt = summary.deltasMs.speech_end_to_first_audio;
  if (rt != null) {
    lines.push(`  Response latency (speech_end → first_audio): ${rt}ms`);
  }

  if (summary.interrupted) lines.push("  (interrupted by caller)");
  if (summary.fallback) lines.push("  (fallback response)");

  writeLog(logger, lines.join("\n"));
}
