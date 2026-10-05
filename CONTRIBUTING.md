# Contributing to SSH Connector

Thanks for helping improve SSH Connector. Open an issue for a bug or feature idea, or send a focused pull request.

## Local setup

Use macOS, Node.js 22.12 or newer, and npm:

```sh
npm ci
npm start
```

## Before a pull request

```sh
npm run check
npm test
npm run test:app
```

The app test needs a macOS desktop session and available Keychain encryption. Tests run against temporary local SSH/SFTP servers and an isolated database.

Describe the problem, the resulting behavior, and how you checked it. Add meaningful coverage for changes to authentication, host verification, storage, or transfers. For UI changes, include a screenshot with demo data; `npm run screenshots` regenerates the README images.

Keep host-key verification, encrypted credential storage, renderer isolation, and confirmation of destructive operations intact.

## Reporting bugs

Include your macOS version, Node.js version when running from source, steps to reproduce, and the observed and expected behavior. For connection issues, mention the authentication method and whether a jump host is involved.

Remove passwords, private keys, OTPs, personal hostnames, IP addresses, and sensitive file paths from logs and screenshots before posting. For a suspected credential or authentication vulnerability, contact the maintainer through the contact information on [their GitHub profile](https://github.com/jevil25) before opening a public report.

Contributions are licensed under the project's [MIT license](LICENSE).
