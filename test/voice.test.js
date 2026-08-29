import test from "node:test";
import assert from "node:assert/strict";
import {
  createVoiceStateMachine,
  VoiceStates,
} from "../src/voice-state.js";
import {
  createVoiceTurnTracker,
  summarizeTurnMetrics,
} from "../src/voice-metrics.js";
import {
  isRecoverableVoiceError,
  sendVoiceFallback,
} from "../src/voice-pipeline.js";
import { voiceConfig } from "../src/config.js";
import { realtimeSessionConfig } from "../src/agent.js";

test("voice state machine allows valid phone-call transitions", () => {
  const sm = createVoiceStateMachine(VoiceStates.IDLE);
  assert.equal(sm.transition(VoiceStates.LISTENING, "connect").ok, true);
  assert.equal(sm.transition(VoiceStates.PROCESSING, "speech_stopped").ok, true);
  assert.equal(sm.transition(VoiceStates.SPEAKING, "audio_start").ok, true);
  assert.equal(sm.transition(VoiceStates.LISTENING, "barge_in").ok, true);
  assert.equal(sm.transition(VoiceStates.PROCESSING, "speech_stopped").ok, true);
});

test("voice state machine rejects listen+speak race", () => {
  const sm = createVoiceStateMachine(VoiceStates.SPEAKING);
  const bad = sm.transition(VoiceStates.IDLE, "invalid");
  assert.equal(bad.ok, false);
});

test("voice turn tracker records latency timestamps", () => {
  const base = Date.parse("2026-08-11T21:03:14.000Z");
  const tracker = createVoiceTurnTracker({ logSummary: false });

  tracker.onSpeechStart(base + 50);
  tracker.onSpeechStop(base + 120);
  tracker.onSttComplete(base + 480);
  tracker.onLlmStart(base + 520);
  tracker.onFirstToken(base + 720);
  tracker.onTtsStart(base + 900);
  tracker.onFirstAudioChunk(base + 910);
  tracker.onPlaybackEnd(base + 3200);

  const summary = summarizeTurnMetrics(tracker.turns[0]);
  assert.equal(summary.deltasMs.stt, 360);
  assert.equal(summary.deltasMs.speech_end_to_first_audio, 790);
  assert.ok(summary.timestamps.speech_end?.endsWith("14.120"));
  assert.ok(summary.timestamps.stt_end?.endsWith("14.480"));
  assert.ok(summary.timestamps.first_audio_chunk?.endsWith("14.910"));
});

test("barge-in finalizes turn as interrupted", () => {
  const tracker = createVoiceTurnTracker({ logSummary: false });
  tracker.onSpeechStart(Date.now());
  tracker.onSpeechStop(Date.now() + 100);
  tracker.onLlmStart(Date.now() + 200);
  tracker.onTtsStart(Date.now() + 300);
  const turn = tracker.onInterrupted(Date.now() + 400);
  assert.equal(turn.interrupted, true);
  assert.equal(turn.reason, "barge_in");
});

test("recoverable vs fatal voice errors", () => {
  assert.equal(isRecoverableVoiceError({ message: "rate_limit exceeded" }), true);
  assert.equal(isRecoverableVoiceError({ message: "503 service unavailable" }), true);
  assert.equal(isRecoverableVoiceError({ message: "invalid_api_key" }), false);
  assert.equal(isRecoverableVoiceError({ message: "401 unauthorized" }), false);
});

test("voice fallback uses response.create", () => {
  const events = [];
  const session = {
    transport: {
      sendEvent(event) {
        events.push(event);
      },
    },
  };
  assert.equal(sendVoiceFallback(session), true);
  assert.equal(events[0]?.type, "response.create");
  assert.match(events[0]?.response?.instructions, /затримка/i);
});

test("voice pipeline config defaults preserve conservative VAD", () => {
  assert.equal(voiceConfig.vadEagerness, "low");
  assert.equal(voiceConfig.outputSpeed, 0.95);
  assert.equal(
    realtimeSessionConfig.config.audio.input.turnDetection.type,
    "semantic_vad"
  );
  assert.equal(
    realtimeSessionConfig.config.audio.input.turnDetection.interruptResponse,
    true
  );
  assert.equal(realtimeSessionConfig.config.audio.output.speed, 0.95);
});
