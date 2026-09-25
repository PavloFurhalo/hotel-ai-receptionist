/**
 * Voice pipeline instrumentation: state machine + latency metrics + fallback.
 * Interface layer only — does not alter booking/conversation logic.
 */

import { voiceConfig } from "./config.js";
import { createVoiceStateMachine, VoiceStates } from "./voice-state.js";
import {
  createVoiceTurnTracker,
  summarizeTurnMetrics,
} from "./voice-metrics.js";

const FALLBACK_INSTRUCTION =
  "Коротко скажи українською одне речення: «Перепрошую, у мене виникла невелика затримка. Повторіть, будь ласка.» Більше нічого.";

export function isRecoverableVoiceError(error) {
  const payload = error?.error ?? error;
  const message = String(
    payload?.message || payload?.code || payload?.type || error?.message || ""
  ).toLowerCase();

  if (
    /invalid_api_key|authentication|unauthorized|401|403|permission/.test(
      message
    )
  ) {
    return false;
  }

  return (
    /rate_limit|timeout|timed out|503|502|504|overloaded|connection|network|temporarily|server_error/.test(
      message
    ) || payload?.type === "server_error"
  );
}

export function sendVoiceFallback(session) {
  if (!session?.transport?.sendEvent) return false;

  try {
    session.transport.sendEvent({
      type: "response.create",
      response: {
        modalities: ["audio", "text"],
        instructions: FALLBACK_INSTRUCTION,
      },
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Attach voice state + latency tracking to a RealtimeSession.
 */
export function attachVoicePipeline(session, call, { logger = console } = {}) {
  const stateMachine = createVoiceStateMachine(VoiceStates.IDLE);
  const tracker = createVoiceTurnTracker({
    logSummary: voiceConfig.latencyLog,
    logger,
  });

  let sawFirstAudioChunk = false;

  const transition = (next, reason) => {
    const result = stateMachine.transition(next, reason);
    if (!result.ok && voiceConfig.debugState) {
      const msg = `[voice-state] rejected ${result.from} → ${result.to} (${reason})`;
      if (typeof logger?.warn === "function") logger.warn(msg);
      else console.warn(msg);
    }
    return result;
  };

  const persistMetrics = () => {
    if (!call) return;
    call.metadata.voiceState = stateMachine.state;
    call.metadata.voiceTurns = tracker.turns.map(summarizeTurnMetrics);
    call.metadata.voiceStateHistory = stateMachine.history.slice(-50);
  };

  session.on("transport_event", (event) => {
    const type = event?.type;
    if (!type) return;

    if (type === "input_audio_buffer.speech_started") {
      sawFirstAudioChunk = false;
      tracker.onSpeechStart();
      transition(VoiceStates.LISTENING, "speech_started");
    }

    if (type === "input_audio_buffer.speech_stopped") {
      tracker.onSpeechStop();
      transition(VoiceStates.PROCESSING, "speech_stopped");
    }

    if (type === "conversation.item.input_audio_transcription.completed") {
      tracker.onSttComplete();
    }

    if (type === "response.created") {
      tracker.onLlmStart();
      if (stateMachine.state !== VoiceStates.SPEAKING) {
        transition(VoiceStates.PROCESSING, "response.created");
      }
    }
  });

  session.on("turn_started", () => {
    sawFirstAudioChunk = false;
    tracker.onLlmStart();
    transition(VoiceStates.PROCESSING, "turn_started");
  });

  session.on("audio_transcript_delta", () => {
    tracker.onFirstToken();
  });

  session.on("audio_start", () => {
    tracker.onTtsStart();
    transition(VoiceStates.SPEAKING, "audio_start");
  });

  session.on("audio", () => {
    if (!sawFirstAudioChunk) {
      sawFirstAudioChunk = true;
      tracker.onFirstAudioChunk();
    }
  });

  session.on("audio_stopped", () => {
    sawFirstAudioChunk = false;
    tracker.onPlaybackEnd();
    transition(VoiceStates.LISTENING, "playback_end");
    persistMetrics();
  });

  session.on("audio_interrupted", () => {
    sawFirstAudioChunk = false;
    tracker.onInterrupted();
    transition(VoiceStates.LISTENING, "barge_in");
    persistMetrics();
  });

  const onConnected = () => {
    stateMachine.reset(VoiceStates.LISTENING);
    transition(VoiceStates.LISTENING, "session_connected");
    persistMetrics();
  };

  return {
    stateMachine,
    tracker,
    onConnected,
    markFallback() {
      tracker.onFallback();
      transition(VoiceStates.PROCESSING, "fallback");
      persistMetrics();
    },
    persistMetrics,
    getSnapshot() {
      return {
        state: stateMachine.state,
        turns: tracker.turns.map(summarizeTurnMetrics),
      };
    },
  };
}
