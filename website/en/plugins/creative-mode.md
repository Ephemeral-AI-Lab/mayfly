# Creative mode walkthrough

`mayfly-cordis` is a native Agent preset registered by Host. It uses Harness
`0.2.2-rc.1` Cordis tools and services and explains the Host/TUI process
boundary.

1. Find service, event, and tool providers with `cordis_inspect_list`.
2. Inspect exact public method schemas with `cordis_inspect_query`.
3. Author a Host extension as an ordinary ESM Cordis package using public native services.
4. Install through the native plugin manager in a dedicated Host profile and restart when its result requires it.
5. Integrate TUI presentation separately through a TUI source composition (`run(argv, { plugins })`), build, restart, and accept it there.

alpha.2 does not supply `cordis_define`, `cordis_run`, `cordis_stop`, or
`cordis_undefine` model tools. The Host runner retains a programmatic lifecycle:
`code.host` runs on Host and `code.client` targets the native browser runner.
Neither is a TUI hot-mount entry. Host plugins cannot inject
frontend-local UI registries.

The Host preset ships three skills for Host extensions, TUI source
integration, and user-owned compositions. Add missing transport capabilities
inside Mayfly Host through public APIs and serializable DTOs. Do not copy
private implementations or add capabilities to dsh upstream. Persistence and
publication follow user authorization and the [publishing workflow](/en/plugins/publishing).
