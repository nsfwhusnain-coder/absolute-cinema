# Security policy

## Reporting a vulnerability

Please report security issues privately using GitHub's
[private vulnerability reporting](https://github.com/nsfwhusnain-coder/absolute-cinema/security/advisories/new)
rather than a public issue. Include steps to reproduce and the version or commit affected.

You should get a response within a week. Once a fix is released the advisory will be
published with credit, unless you prefer to stay anonymous.

## Scope notes

- Absolute Cinema is designed to run on a home server or private network. If you expose it
  to the internet, put it behind HTTPS and keep registration closed (the default).
- API tokens are stored in the server's SQLite database and are never sent to browsers.
- The HLS proxy refuses private, loopback, link-local and CGNAT addresses, including after
  redirects.
