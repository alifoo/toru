# Security

Please do not report vulnerabilities, credentials or private recordings in public issues.

Report them privately, either way:

- GitHub's private vulnerability reporting, in the Security tab of [alifoo/toru](https://github.com/alifoo/toru);
- or e-mail **support@toru.tools** with "Security" in the subject.

Include the release or commit, the operating system, browser and driver versions, and safe steps to reproduce. Leave
out session cookies, API keys, full page contents and anyone's data. You will get an answer within a few working days.
This is a small project with no bug bounty and no support SLA.

## What a self-hoster should know

- **One admin key per server.** The console reaches the recorder's `/admin/*` routes with `RECORDER_ADMIN_KEY` plus an
  account id; the recorder checks it in constant time. Anyone holding that key can act as any account on that server.
  Keep it in a secret store, give it to the console only, and rotate it if it may have leaked.
- **The browser sandbox stays on.** Public hosting needs a working Chromium sandbox (or verified VM isolation), HTTPS,
  the origin and egress controls, and separate accounts. Do not turn the sandbox off to make a deployment start.
- **The delivery check is public.** A video is held back when it is shorter than 1.5 s, nearly blank (luma range under
  24) or static (frame difference under 0.3); a file the probe cannot read is not held. It protects users from paying
  for a broken video; it is not a security control.
- **Redaction is best effort.** The recorder blurs the signed-in identity it detects, but cannot promise every piece of
  personal information on a page is hidden. Record with demo accounts.
