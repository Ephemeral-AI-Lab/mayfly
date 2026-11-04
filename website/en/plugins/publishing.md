# Publishing

Publish a Mayfly plugin as an ordinary npm Cordis package. Before publication:

- `package.json.exports` targets real JS and type files;
- `files` includes build output; an installable Host bundle also includes its native `cordis.patch.yml`;
- dsh and Mayfly packages use appropriate peer dependencies;
- the tarball independently installs and passes tests in an empty directory;
- README documents install, injected services, unload behavior, and profile
  acceptance;
- package name, version, tag, access, provenance, and 2FA are explicit.

```sh
npm pack
npm publish --access public
```

Publish only after explicit authorization for the exact package, version, and
tag. GitHub repository creation and npm publication are separate actions.

Host bundles can be [submitted to the Marketplace](/en/market/submit) for discovery through `/plugin`. A frontend UI package currently requires source integration into Remote, a build, and a restart; publishing it does not create a TUI installation or hot-loading path.
