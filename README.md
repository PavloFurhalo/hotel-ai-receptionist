# Hotel AI Receptionist — V1.2

Production-like Ukrainian voice receptionist prototype for hotels.

Stack: Twilio Voice + Media Streams → Fastify WebSocket bridge → OpenAI Realtime (`gpt-realtime`) → local JSON/TXT call logs.

Hotel persona: fictional **Carpathian Grand** (Львів). Demo data only.

## V1.2 changes

- Understand before answering; unclear ASR must be clarified, not guessed.
- New clear topic beats unfinished booking; reservation stays in memory.
- Mid-call greetings / «Добре» / «Супер» / «Дякую, а ще…» do not end or reset the call.
- Confirmation + extra question → answer the question first, one coherent reply.
- Latest explicit booking correction wins (`виїзд 17-го`).
- Deterministic QA flags forced booking return, hallucinated unclear intent, duplicate completions.

## Run locally

```bash
cd /Users/pavlofurhalo/airep/hotel-ai-receptionist
npm install
cp .env.example .env
# fill OPENAI_API_KEY and PUBLIC_BASE_URL
npm start
```

```bash
ngrok http 5050
```

Set `PUBLIC_BASE_URL` to the ngrok HTTPS URL (no trailing slash), restart `npm start`.

## Env variables

| Variable | Required | Purpose |
|----------|----------|---------|
| `OPENAI_API_KEY` | yes | Realtime API |
| `PUBLIC_BASE_URL` | yes for phone tests | ngrok HTTPS URL |
| `PORT` | no | default `5050` |
| `TWILIO_ACCOUNT_SID` | curl only | outbound test calls |
| `TWILIO_AUTH_TOKEN` | curl only | outbound test calls |

Never commit `.env`.

## Outbound test call

```bash
curl -X POST "https://api.twilio.com/2010-04-01/Accounts/$TWILIO_ACCOUNT_SID/Calls.json" \
  --data-urlencode "To=+380677486490" \
  --data-urlencode "From=+14066294775" \
  --data-urlencode "Url=https://<NGROK_URL>/incoming-call" \
  -u "$TWILIO_ACCOUNT_SID:$TWILIO_AUTH_TOKEN"
```

After the call inspect:

- `data/transcripts/<CallSid>.txt`
- `data/calls/<timestamp>-<CallSid>.json` → `reservationDraft`, `qa`
- `GET http://localhost:5050/health` (`stage: "v1.2"`)
- `GET http://localhost:5050/calls/<CallSid>/transcript`

## Local tests (no API spend)

```bash
npm test
```

## Config

- model: `gpt-realtime`
- voice: `coral`
- ASR: `gpt-4o-mini-transcribe`, `language: uk`
- VAD: `semantic_vad`, `eagerness: low`

## Known limitations

- Relative dates are stored as spoken, not ISO.
- No PMS / live availability / real booking.
- Conversation policy is enforced in prompt + deterministic helpers; the live model can still drift.
- No LLM evaluator yet.
- ASR quality on mixed Ukrainian/Russian phone audio remains a source of garbled turns.
