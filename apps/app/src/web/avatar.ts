// Every avatar in the UI comes through here. Normally that's GitHub's `<login>.png`; in demo mode
// (the server says so in /api/health) it's a generated image from the local server, because the
// demo's people are fictional and their logins could belong to real strangers on GitHub.

let demo = false;

/** Set once at startup from /api/health, before the first render. */
export function setDemoAvatars(on: boolean) {
  demo = on;
}

/** Avatar for a GitHub user or org login. */
export function avatarUrl(login: string, size = 64): string {
  return demo ? `/api/avatar/${encodeURIComponent(login)}?size=${size}` : `https://github.com/${login}.png?size=${size}`;
}
