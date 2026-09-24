// Set at build time by scripts/build.ts (`define`); unset when running from source.
export const VERSION = process.env.PR_BUNNY_VERSION ?? "dev";
/** Each release has a codename (rabbit food, alphabetical: Alfalfa, Basil, Clover…). */
export const CODENAME = process.env.PR_BUNNY_CODENAME ?? "Source";
/** True inside the compiled `bunny` binary, where the repo isn't on disk. */
export const COMPILED = VERSION !== "dev";
/** The public repo; its GitHub Releases (tag v<version>) hold the release files. */
export const GITHUB_REPO = "DailyStandup-io/pr-bunny";
