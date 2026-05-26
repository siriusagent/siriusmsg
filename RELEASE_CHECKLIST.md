# Release Checklist

This repository is public. Treat every file here as internet-visible.

Before publishing a release:

1. Build the signed SiriusMsg app from the private development repository.
2. Notarize and staple the app and distribution DMG.
3. Verify the DMG with Gatekeeper and `hdiutil`.
4. Generate `SiriusMsg-notarized.dmg.sha256`.
5. Copy only public website files, app icon PNG, release notes, DMG, checksum, and appcast metadata into the release workflow.
6. Run the secret audit against this public repository.
7. Confirm no source code, private repo URLs, local database files, logs, tokens, signing assets, keychain exports, or machine-specific validation artifacts are present.
8. Create the GitHub Release as a draft first.
9. Attach the DMG and checksum.
10. Re-check the rendered GitHub Pages site and release download links before marking the release public.

Recommended local checks:

```sh
tools/audit-public-release.sh
git status --short
```

If `gitleaks` is installed, also run:

```sh
gitleaks detect --no-git --source .
```
