import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sortTranscript } from "./conversation.js";
import { buildCallQa } from "./qa.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, "../data");
const CALLS_DIR = path.join(DATA_DIR, "calls");
const TRANSCRIPTS_DIR = path.join(DATA_DIR, "transcripts");

const pendingByCallSid = new Map();

function nowIso() {
  return new Date().toISOString();
}

function sanitizeFilenamePart(value) {
  return String(value || "unknown").replace(/[^a-zA-Z0-9_-]/g, "_");
}

function toFilenameTimestamp(iso) {
  return iso.replace(/[:.]/g, "-");
}

async function ensureDirs() {
  await mkdir(CALLS_DIR, { recursive: true });
  await mkdir(TRANSCRIPTS_DIR, { recursive: true });
}

function serializeError(error) {
  if (!error) {
    return { message: "Unknown error" };
  }

  if (typeof error === "string") {
    return { message: error };
  }

  if (error instanceof Error) {
    return {
      message: error.message,
      name: error.name,
    };
  }

  if (typeof error === "object") {
    const message =
      error.message ||
      error.error?.message ||
      error.error?.code ||
      JSON.stringify(error);

    return {
      message: String(message),
      code: error.code || error.error?.code || null,
      type: error.type || error.error?.type || null,
    };
  }

  return { message: String(error) };
}

export function createCallLog({
  callSid = null,
  from = null,
  to = null,
  direction = null,
  metadata = {},
  silent = false,
} = {}) {
  const startedAt = nowIso();
  const call = {
    callSid,
    startedAt,
    endedAt: null,
    durationSeconds: 0,
    from,
    to,
    direction,
    status: "in_progress",
    transcript: [],
    errors: [],
    reservationDraft: null,
    qa: null,
    metadata: {
      interruptions: 0,
      interruptionEvents: [],
      ...metadata,
    },
    _loggedItemIds: new Set(),
    _finished: false,
    _announced: false,
  };

  if (callSid) {
    pendingByCallSid.set(callSid, call);
  }

  if (!silent) {
    announceCallStarted(call);
  }

  return call;
}

export function announceCallStarted(call) {
  if (!call || call._announced) return;
  call._announced = true;
  console.log("\nCALL STARTED");
  console.log(`Call SID: ${call.callSid || "(pending)"}`);
  if (call.from) console.log(`From: ${call.from}`);
  if (call.to) console.log(`To: ${call.to}`);
}

export function getPendingCall(callSid) {
  if (!callSid) return null;
  return pendingByCallSid.get(callSid) || null;
}

export function attachCallSid(call, callSid) {
  if (!call || !callSid) return call;

  if (call.callSid && call.callSid !== callSid) {
    call.metadata.previousCallSid = call.callSid;
  }

  if (call.callSid && pendingByCallSid.get(call.callSid) === call) {
    pendingByCallSid.delete(call.callSid);
  }

  call.callSid = callSid;
  pendingByCallSid.set(callSid, call);
  return call;
}

export function mergeCallMetadata(call, patch = {}) {
  if (!call) return;

  if (patch.callSid && !call.callSid) {
    attachCallSid(call, patch.callSid);
  }

  if (patch.from && !call.from) call.from = patch.from;
  if (patch.to && !call.to) call.to = patch.to;
  if (patch.direction && !call.direction) call.direction = patch.direction;

  if (patch.metadata && typeof patch.metadata === "object") {
    call.metadata = { ...call.metadata, ...patch.metadata };
  }
}

export function addTranscriptEntry(call, speaker, text, { itemId = null } = {}) {
  if (!call || !text || !String(text).trim()) return null;

  const normalized = String(text).trim();
  if (itemId && call._loggedItemIds.has(itemId)) {
    return null;
  }

  const entry = {
    timestamp: nowIso(),
    speaker,
    text: normalized,
  };

  if (itemId) {
    entry.itemId = itemId;
    call._loggedItemIds.add(itemId);
  }

  call.transcript.push(entry);

  const label = speaker === "caller" ? "CALLER" : "ASSISTANT";
  console.log(`\n${label}:`);
  console.log(normalized);

  return entry;
}

export function recordInterruption(call, details = {}) {
  if (!call) return null;

  call.metadata.interruptions = (call.metadata.interruptions || 0) + 1;
  if (!Array.isArray(call.metadata.interruptionEvents)) {
    call.metadata.interruptionEvents = [];
  }

  const lastCaller = [...call.transcript]
    .reverse()
    .find((entry) => entry.speaker === "caller");
  const lastAssistant = [...call.transcript]
    .reverse()
    .find((entry) => entry.speaker === "assistant");

  const event = {
    timestamp: nowIso(),
    count: call.metadata.interruptions,
    currentAssistantItemId:
      details.currentAssistantItemId || lastAssistant?.itemId || null,
    callerTranscript: details.callerTranscript || lastCaller?.text || null,
  };

  call.metadata.interruptionEvents.push(event);
  console.log("\nAUDIO INTERRUPTED");
  console.log(JSON.stringify(event));
  return event;
}

export function addError(call, error) {
  if (!call) return null;

  const entry = {
    timestamp: nowIso(),
    ...serializeError(error),
  };

  call.errors.push(entry);
  console.error("\nCALL ERROR:");
  console.error(entry.message);
  return entry;
}

export function formatReadableTranscript(call) {
  const transcript = sortTranscript(call.transcript || []);
  const lines = [
    `CALL SID: ${call.callSid || "unknown"}`,
    `STARTED: ${call.startedAt || ""}`,
    `ENDED: ${call.endedAt || ""}`,
    `FROM: ${call.from || ""}`,
    `TO: ${call.to || ""}`,
    "",
    "------------------------------",
    "",
  ];

  for (const entry of transcript) {
    const label = entry.speaker === "caller" ? "CALLER" : "ASSISTANT";
    lines.push(`${label}:`);
    lines.push(entry.text);
    lines.push("");
  }

  lines.push("------------------------------");
  lines.push("");
  return lines.join("\n");
}

export async function writeTranscript(call) {
  await ensureDirs();
  const callSid = sanitizeFilenamePart(call.callSid || "unknown");
  const transcriptPath = path.join(TRANSCRIPTS_DIR, `${callSid}.txt`);
  const content = formatReadableTranscript(call);
  await writeFile(transcriptPath, content, "utf8");
  return transcriptPath;
}

export async function finishCall(call, { status = "completed" } = {}) {
  if (!call || call._finished) {
    return call;
  }

  call._finished = true;
  call.endedAt = nowIso();
  call.status =
    call.errors.length > 0 && status === "completed" ? "error" : status;

  const startedMs = Date.parse(call.startedAt);
  const endedMs = Date.parse(call.endedAt);
  call.durationSeconds =
    Number.isFinite(startedMs) && Number.isFinite(endedMs)
      ? Math.max(0, Math.round((endedMs - startedMs) / 1000))
      : 0;

  call.transcript = sortTranscript(call.transcript || []);

  await ensureDirs();

  const timestamp = toFilenameTimestamp(call.startedAt);
  const callSid = sanitizeFilenamePart(call.callSid || "unknown");
  const jsonFilename = `${timestamp}-${callSid}.json`;
  const jsonPath = path.join(CALLS_DIR, jsonFilename);

  const callerTurnCount = call.transcript.filter(
    (e) => e.speaker === "caller"
  ).length;
  const assistantTurnCount = call.transcript.filter(
    (e) => e.speaker === "assistant"
  ).length;

  call.metadata = {
    ...call.metadata,
    interruptions: call.metadata.interruptions || 0,
    interruptionEvents: call.metadata.interruptionEvents || [],
    transcriptItemCount: call.transcript.length,
    callerTurnCount,
    assistantTurnCount,
    durationSeconds: call.durationSeconds,
    status: call.status,
    reservationDraft: call.reservationDraft ?? null,
  };

  call.qa = buildCallQa({
    transcript: call.transcript,
    reservationDraft: call.reservationDraft,
    metadata: call.metadata,
    errors: call.errors,
  });

  const serializable = {
    callSid: call.callSid,
    startedAt: call.startedAt,
    endedAt: call.endedAt,
    durationSeconds: call.durationSeconds,
    from: call.from,
    to: call.to,
    direction: call.direction,
    status: call.status,
    transcript: call.transcript.map(({ timestamp, speaker, text, itemId }) => ({
      timestamp,
      speaker,
      text,
      ...(itemId ? { itemId } : {}),
    })),
    errors: call.errors,
    reservationDraft: call.reservationDraft ?? null,
    qa: call.qa,
    metadata: call.metadata,
  };

  try {
    await writeFile(jsonPath, JSON.stringify(serializable, null, 2), "utf8");
  } catch (error) {
    console.error("Failed to write call JSON:", error?.message || error);
  }

  let transcriptPath = null;
  try {
    transcriptPath = await writeTranscript(call);
  } catch (error) {
    console.error("Failed to write transcript:", error?.message || error);
  }

  if (call.callSid) {
    pendingByCallSid.delete(call.callSid);
  }

  console.log("\nCALL ENDED");
  console.log(`Duration: ${call.durationSeconds} seconds`);
  console.log(
    `Turns: caller=${callerTurnCount} assistant=${assistantTurnCount} interruptions=${call.metadata.interruptions || 0}`
  );
  console.log(`QA score: ${call.qa?.overallScore ?? "n/a"}`);
  if (call.reservationDraft) {
    console.log("RESERVATION DRAFT:");
    console.log(JSON.stringify(call.reservationDraft, null, 2));
  }
  if (transcriptPath) {
    console.log("TRANSCRIPT SAVED:");
    console.log(path.relative(process.cwd(), transcriptPath));
  }
  console.log("CALL LOG SAVED:");
  console.log(path.relative(process.cwd(), jsonPath));

  return {
    ...serializable,
    jsonPath,
    transcriptPath,
  };
}

export async function listCalls() {
  await ensureDirs();
  const files = await readdir(CALLS_DIR);
  const jsonFiles = files.filter((name) => name.endsWith(".json"));

  const calls = [];
  for (const file of jsonFiles) {
    try {
      const raw = await readFile(path.join(CALLS_DIR, file), "utf8");
      const data = JSON.parse(raw);
      calls.push({
        callSid: data.callSid,
        startedAt: data.startedAt,
        endedAt: data.endedAt,
        durationSeconds: data.durationSeconds,
        status: data.status,
        qaScore: data.qa?.overallScore ?? null,
        filename: file,
      });
    } catch {
      // Skip unreadable files.
    }
  }

  calls.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
  return calls;
}

export async function getCallBySid(callSid) {
  await ensureDirs();
  const files = await readdir(CALLS_DIR);
  const match = files
    .filter(
      (name) =>
        name.endsWith(".json") && name.includes(sanitizeFilenamePart(callSid))
    )
    .sort()
    .reverse()[0];

  if (!match) {
    for (const file of files.filter((name) => name.endsWith(".json"))) {
      try {
        const raw = await readFile(path.join(CALLS_DIR, file), "utf8");
        const data = JSON.parse(raw);
        if (data.callSid === callSid) {
          return data;
        }
      } catch {
        // ignore
      }
    }
    return null;
  }

  const raw = await readFile(path.join(CALLS_DIR, match), "utf8");
  return JSON.parse(raw);
}

export async function getTranscriptText(callSid) {
  await ensureDirs();
  const transcriptPath = path.join(
    TRANSCRIPTS_DIR,
    `${sanitizeFilenamePart(callSid)}.txt`
  );

  try {
    return await readFile(transcriptPath, "utf8");
  } catch {
    const call = await getCallBySid(callSid);
    if (!call) return null;
    return formatReadableTranscript(call);
  }
}

export const paths = {
  dataDir: DATA_DIR,
  callsDir: CALLS_DIR,
  transcriptsDir: TRANSCRIPTS_DIR,
};
