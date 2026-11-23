# Deploy the phone-only G2 app — v0.6

Deploy **one `.ehpk` package**. Do not deploy a Helix server or fill in a server WSS address.

## Build

```bash
npm install
bash scripts/run_gate.sh
npm run pack:g2
```

Output: `apps/g2-plugin/helix-g2.ehpk`. Manifest version 0.6.0, SDK 0.0.14, minimum Even App 2.2.9. Package validation is not installation evidence. See `MEMORY_FACTS_QA.md` for the current private-upload/device boundary.

## Install and configure

1. Pair G2 in the Even Realities phone app. Use the same account in Even Hub and enable the developer flow available to that account.
2. Upload `helix-g2.ehpk` using Even Hub's **Upload a build** flow, then open the private build from the phone's Even Hub/developer area. Portal availability and exact account-specific installation controls must be checked live.
3. Open **API keys & setup** in Helix. Enter the OpenAI key in its masked field; select **OpenAI Whisper** for transcription and **OpenAI Responses** for answers. No other provider key is necessary for this configuration.
4. To import Omi conversations, enter an Omi Developer API key and use **History → Import Omi**. Imports are explicit; live answers use the history already saved on this phone. Leave saving keys off to keep keys in runtime memory, or explicitly opt in to ordinary local storage on your personal phone.
5. Connect, then Start listening. Say a context sentence followed by a question. Check the phone transcript and answer bubble; only assistant output appears on glasses. Single press requests recent/local help; double press requests whole-session/global help. Either replaces the older answer request. Hold/release submits speech. Use phone Pause/Disconnect or system exit to stop; double press no longer exits in v0.5.

The phone needs internet to reach OpenAI. “Phone-only” describes where Helix runs, not where cloud AI inference runs. The `.ehpk` contains application files but no credentials. A local Vite server is useful for development only and is not required by the packaged app.

## Troubleshooting

- No key field: open API keys & setup; ensure the installed manifest is v0.6.0, not an older gateway build.
- Authentication: check key permissions and provider account. Billing/rate limits require provider account action, not a Helix server.
- Transcription delay: Whisper processes submitted WAV clips, not word-by-word deltas. Speech uploads no longer wait for the answer to finish, but STT provider latency can still cause queueing. Natural pauses, hold release and the continuous-speech segment cap trigger submission.
- Blank glasses: expected when idle or after the last answer page expires. Transcript, notes and errors are intentionally phone-only. Ask local/global help to generate fresh output.
- Session context limit (v0.15): past 96,000 bytes of captured speech the oldest lines roll off and the session keeps running. There is no on-screen notice when this happens; the saved transcript in History is complete.
- Network failure on a real phone: verify the direct provider request and Even App network permissions. Do not silently introduce a proxy as a workaround.
- Notes say “Captured this session”: these notes are session-only. Automatic Omi sync is not available; History import separately saves Omi conversations on this phone.

See ANSWER_FIRST_QA.md for v0.5 evidence and still-unverified physical-device gates. PHONE_ONLY_QA.md is the historical v0.4 live-provider run.
