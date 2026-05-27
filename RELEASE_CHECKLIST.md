# Release Checklist

This repository is public. Treat every file here as internet-visible.

Before publishing a release:

1. Build the signed SiriusMsg app from the private development repository.
2. Notarize and staple the app and distribution DMG.
3. Verify the DMG with Gatekeeper and `hdiutil`.
4. Inspect the DMG app Info.plist and fail the release if `SUPublicEDKey` is missing, blank, or still a placeholder.
5. Generate `SiriusMsg-notarized.dmg.sha256`.
6. Copy only public website files, app icon PNG, release notes, DMG, checksum, and appcast metadata into the release workflow.
7. Run the secret and release-DMG audit against this public repository.
8. Confirm no source code, private repo URLs, local database files, logs, tokens, signing assets, keychain exports, or machine-specific validation artifacts are present.
9. Create the GitHub Release as a draft first.
10. Attach the DMG and checksum.
11. Re-check the rendered GitHub Pages site, release download links, and appcast links before marking the release public.

Recommended local checks:

```sh
tools/audit-public-release.sh
git status --short
```

With a candidate DMG:

```sh
SIRIUSMSG_RELEASE_DMG=/path/to/SiriusMsg-notarized.dmg tools/audit-public-release.sh
```

If `gitleaks` is installed, also run:

```sh
gitleaks detect --no-git --source .
```
