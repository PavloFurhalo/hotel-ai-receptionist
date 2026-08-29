/**
 * Minimal voice assistant state machine for Realtime phone sessions.
 * Prevents invalid concurrent states (listen + speak + process).
 */

export const VoiceStates = {
  IDLE: "idle",
  LISTENING: "listening",
  PROCESSING: "processing",
  SPEAKING: "speaking",
};

const VALID_TRANSITIONS = {
  [VoiceStates.IDLE]: [VoiceStates.LISTENING],
  [VoiceStates.LISTENING]: [
    VoiceStates.LISTENING,
    VoiceStates.PROCESSING,
    VoiceStates.SPEAKING,
  ],
  [VoiceStates.PROCESSING]: [
    VoiceStates.PROCESSING,
    VoiceStates.SPEAKING,
    VoiceStates.LISTENING,
  ],
  [VoiceStates.SPEAKING]: [
    VoiceStates.LISTENING,
    VoiceStates.PROCESSING,
  ],
};

export function createVoiceStateMachine(initialState = VoiceStates.IDLE) {
  let state = initialState;
  const history = [];

  function transition(nextState, reason = "") {
    const allowed = VALID_TRANSITIONS[state] || [];
    if (!allowed.includes(nextState)) {
      return {
        ok: false,
        from: state,
        to: nextState,
        reason,
      };
    }

    const entry = {
      from: state,
      to: nextState,
      reason,
      at: Date.now(),
    };
    history.push(entry);
    state = nextState;

    return { ok: true, ...entry };
  }

  return {
    get state() {
      return state;
    },
    get history() {
      return [...history];
    },
    transition,
    reset(nextState = VoiceStates.IDLE) {
      state = nextState;
      history.length = 0;
    },
  };
}
