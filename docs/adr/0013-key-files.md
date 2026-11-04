# ADR 0013 — Key files: sharing a Gemini key with someone else

- **Status:** Accepted (2026-11-04). Built for version 1.1.0.

## Context
The owner wants to give the app to interviewees and let them use the owner's Gemini key, without sending the key in plain text.

What any client-side app can and can't do here:
- **The app can't keep the key secret from the person running it:** it must send the key to Google with every request, so someone with technical skill could recover it (from memory or network traffic), however it's stored.
- **What can be protected:**
  - the key in transit (email, chat);
  - casual exposure (the key is never displayed);
  - a time limit.
- **The real control is Google-side:** a separate key per person, deleted in Google AI Studio when no longer needed.
- **The only way to keep a key truly secret** is a server that holds it and makes the requests. Considered and not built: it needs hosting and accounts, which conflicts with "just use it" and with the local-only design.

## Decision
- **A key file (`.aickey`, JSON):** the key, a label ("Alex Kim") and an optional end date.
  - **Encryption:** AES-256-GCM, with the key derived from a password by scrypt (N = 2^17, r = 8, p = 1: about 128 MiB and a few hundred milliseconds per guess).
  - **The header** (format, version, key-derivation settings) is authenticated with the payload, so neither can be changed without the password.
  - **Each file is unique** (random salt and nonce).
  - **When reading,** key-derivation settings outside safe bounds are refused, so a crafted file can't stall the app.
- **The owner creates it:** Settings → **Share your key** → **Create key file**.
  - They enter the key to share, who it's for, a password (at least 8 characters, typed twice) and an optional "works until" date.
  - The key is checked with Google first, so a broken key isn't handed out.
  - The dialog recommends a separate key per person and says plainly what the file doesn't protect against.
- **The interviewee imports it:** on Home ("Someone gave you a key file? Import it") or in Settings, choosing the file and typing the password. A wrong password or a changed file is refused with a clear message.
- **After import** the key is stored like a typed one (OS-protected) and never displayed. Settings shows "From a key file (Alex Kim), works until …".
- **Expiry is enforced wherever the key is used.** After the date, requests fail with "The key file you imported expired on … Ask for a new one". The status shows "Expired", including after a restart. This can be bypassed by someone with technical skill, so deleting the key in Google AI Studio is the dependable end date.
- **Storage:** the key's origin (typed or file), label and end date are stored with the provider configuration (migration 6). Typing a key in replaces a key file's.
- **Where the work happens:** decryption and encryption run in the main process, which already holds keys. The renderer sends only the file's bytes and the password.

## Consequences
- **Revoking access:** the owner deletes that person's key in Google AI Studio, which works immediately and everywhere.
- **Without separate keys,** a shared key's usage and cost are the owner's and can't be told apart per person.
- **A server mode** (the owner's key never leaves their machine or server) remains possible later if a key must stay truly secret.
