# Hotel AI Receptionist — V1.3 (multi-hotel)

Ukrainian voice receptionist prototype for hotels.

Stack: Twilio Voice + Media Streams → Fastify WebSocket bridge → OpenAI Realtime (`gpt-realtime`) → local JSON/TXT call logs.

## Architecture

```
Phone Number → Hotel → Hotel Configuration → AI Session → OpenAI Realtime
```

One server serves many hotels. Routing is data-driven via `hotels/phone-numbers.json` (no hardcoded `if number === ...`).

Voice pipeline is unchanged:

```
Twilio → TwilioRealtimeTransportLayer → OpenAI Realtime → streaming audio
```

## Seeded test hotels

| Hotel ID | Name | Phone | Notes |
|----------|------|-------|-------|
| `grand-hotel-lviv` | Grand Hotel Lviv | `+14066294775` | Current Twilio number (Hotel A) |
| `carpathian-resort` | Carpathian Resort | `+380000000002` | Test mapping (Hotel B, no SIP) |
| `inactive-demo-hotel` | Inactive Demo Hotel | `+380000000099` | Inactive — must reject |

Configs: `hotels/*.json`  
Phone map: `hotels/phone-numbers.json`

## Run locally

```bash
npm install
cp .env.example .env
# fill OPENAI_API_KEY and PUBLIC_BASE_URL
npm run seed:hotels
npm start
```

```bash
ngrok http 5050
```

## Test Hotel A (existing Twilio number)

Outbound call — `From` is the hotel Twilio line → resolves Grand Hotel Lviv:

```bash
curl -X POST "https://api.twilio.com/2010-04-01/Accounts/$TWILIO_ACCOUNT_SID/Calls.json" \
  --data-urlencode "To=+380677486490" \
  --data-urlencode "From=+14066294775" \
  --data-urlencode "Url=https://<NGROK_URL>/incoming-call" \
  -u "$TWILIO_ACCOUNT_SID:$TWILIO_AUTH_TOKEN"
```

Ask about check-in — should say **14:00**. Breakfast hours **08:00–11:00**.

## Test Hotel B without SIP

1. Set in `.env`: `ALLOW_HOTEL_OVERRIDE=true` (dev/test only; never in production).
2. Restart server.
3. Call with override:

```bash
curl -X POST "https://api.twilio.com/2010-04-01/Accounts/$TWILIO_ACCOUNT_SID/Calls.json" \
  --data-urlencode "To=+380677486490" \
  --data-urlencode "From=+14066294775" \
  --data-urlencode "Url=https://<NGROK_URL>/incoming-call?hotelId=carpathian-resort" \
  -u "$TWILIO_ACCOUNT_SID:$TWILIO_AUTH_TOKEN"
```

Ask about check-in — should say **15:00**. Breakfast **07:30–10:30**. SPA available.

Override is rejected when `ALLOW_HOTEL_OVERRIDE` is off / `NODE_ENV=production`.

## Local tests

```bash
npm run seed:hotels
npm test
```

## Useful endpoints

- `GET /health` — stage + hotel ids
- `GET /hotels` — list hotels
- `GET /hotels/:id` — hotel config
- `GET /phone-numbers` — phone → hotel map
- `GET /calls` / `/calls/:callSid` — call logs include `hotelId`

Media stream URL shape: `wss://…/media-stream/<hotelId>` (Twilio strips query params, so hotelId is in the path).

## Env variables

| Variable | Required | Purpose |
|----------|----------|---------|
| `OPENAI_API_KEY` | yes | Realtime API |
| `PUBLIC_BASE_URL` | yes for phone tests | ngrok HTTPS URL |
| `PORT` | no | default `5050` |
| `ALLOW_HOTEL_OVERRIDE` | no | `true` enables `?hotelId=` for Hotel B tests |
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` | curl only | outbound tests |

## Config (unchanged voice pipeline)

- model: `gpt-realtime`
- voice: `marin` (env `REALTIME_VOICE`; alternatives: coral, shimmer, verse…)
- ASR: `gpt-4o-mini-transcribe`, `language: uk`
- VAD: `semantic_vad`, eagerness from env (default `low`)

## Known limitations

- File-based hotel registry (no SQL DB yet).
- No SIP / second real Twilio number yet.
- No PMS / live availability / real booking.
- Relative dates stored as spoken, not ISO.
- Live model can still drift from prompt policy.
