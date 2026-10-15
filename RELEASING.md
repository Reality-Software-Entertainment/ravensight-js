Push a tag `vX.Y.Z` that equals the version in package.json; `.github/workflows/publish.yml` publishes to npm with provenance through trusted publishing (OIDC), with no token.
The publish job is skipped until the owner, on npmjs.com, opens package `ravensight`, Settings, Trusted publishing, and adds GitHub Actions for `Reality-Software-Entertainment/ravensight-js` with workflow file `publish.yml`.
Then set the repository variable `NPM_TRUSTED_PUBLISHING` to `true` (Settings, Secrets and variables, Actions, Variables) and re-run the publish for the latest tag.
