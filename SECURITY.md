# Security policy

Please report vulnerabilities privately. Do not open a public issue.

## How to report

- **Preferred:** [GitHub private vulnerability reporting](https://github.com/neurouter/neurouter/security/advisories/new)
- **Email:** signup@neurouter.com (put "SECURITY" in the subject)

Include the affected version or commit, the deployment shape (Docker, Helm, config that matters),
steps to reproduce, and the impact you observed.

## What to expect

- Acknowledgement within 3 business days.
- Triage update within 10 business days: whether we reproduced it, severity, next steps.
- Coordinated disclosure: we aim to ship a fix and publish an advisory within 90 days.
- Credit in the advisory if you want it.

## Supported versions

Neurouter is pre-1.0. Security fixes go to the latest release only.

## Scope and safe harbor

The full policy, including scope and safe-harbor terms, is at
[neurouter.com/security](https://neurouter.com/security). The gateway's security model
(authentication, ACL, no token passthrough, envelope encryption, audit chain) is described in the
[docs](https://neurouter.com/docs).
